import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test, before, after } from 'node:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { KitchenModel } from '../../src/shared/data.js';
import { executeCommand, getPrivateMaterials, getState, getOrderHistory, loadState, seedTenant, tokyoToday } from '../../backend/repository.js';

let runtime;
let db;
before(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'repository-test', modules: true, script: 'export default { fetch() { return new Response("ok"); } };', compatibilityDate: '2026-10-08', d1Databases: { DB: 'business-test' } }] }));
  db = await runtime.getD1Database('DB');
  for (const file of ['0001_business.sql', '0002_auth.sql', '0009_notifications.sql']) {
    const migration = await readFile(new URL('../../backend/migrations/' + file, import.meta.url), 'utf8');
    await db.exec(migration.replace(/--[^\n]*/g, '').replace(/\s+/g, ' '));
  }
});
after(async () => { await runtime?.dispose(); });

function initialState() {
  const model = new KitchenModel();
  model.storage = null;
  model.save = () => {};
  model.state.orders = [];
  model.state.products = [];
  model.state.documents = [];
  model.state.inventory = {};
  model.state.prices = {};
  model.state.quoteMeta = {};
  model.state.stores = [
    { id: 'store-a', name: '门店 A', account: 'store_a' },
    { id: 'store-b', name: '门店 B', account: 'store_b' },
  ];
  const product = model.addProduct({ name: '牛骨', category: '冷冻品', unit: '箱', stock: 10, basePrice: 1500, spec: '15KG/箱' });
  model.setSaleUnits(product.id, [{ unit: '箱', perBase: 1 }, { unit: 'KG', perBase: 15 }]);
  model.setUnitQuote('store-a', product.id, 'KG', 120, 'exclusive', 0.08);
  model.setUnitQuote('store-b', product.id, 'KG', 150, 'inclusive', 0.1);
  product.referencePrice = 999;
  product.costReferences = ['private-cost'];
  product.source = '/materials/private.pdf';
  model.state.privateMaterials = { materialCosts: [{ product: '牛骨', cost: 1 }], procurementAttachment: ['private-supplier'] };
  return model.state;
}

async function setup(name) {
  const state = initialState();
  await seedTenant(db, { tenantId: name, state });
  const admin = { tenantId: name, userId: `admin-${name}`, role: 'admin' };
  const store = { tenantId: name, userId: `store-${name}`, role: 'store', storeId: 'store-a' };
  return { admin, store, pid: state.products[0].id };
}

function command(type, args, extra = {}) {
  const expectedQuotes = type === 'submitOrder' ? Object.fromEntries(Object.keys(args[1]).map(pid => [pid, { price: 1500, taxBasis: 'unspecified', taxRate: null, unit: args[4]?.[pid] || '箱', perBase: 1 }])) : undefined;
  return { type, args, idempotencyKey: crypto.randomUUID(), ...(expectedQuotes ? { expectedQuotes } : {}), ...extra };
}

test('manual todos persist for the kitchen with server-owned source and authorship', async () => {
  const { admin, store } = await setup('manual-todo-save');
  const actor = { ...admin, displayName: '负责人' };
  const saved = await executeCommand(db, actor, command('addManualTask', [{ title: '  联系司机  ', note: '确认周末的配送时间', dueDate: '2026-10-25' }]));
  const todo = saved.result;
  assert.equal(todo.source, 'manual'); assert.equal(todo.title, '联系司机');
  assert.equal(todo.note, '确认周末的配送时间');
  assert.equal(todo.dueDate, '2026-10-25');
  assert.equal(todo.createdBy, actor.userId); assert.equal(todo.createdByName, '负责人');
  assert.equal(todo.completedAt, null); assert.equal(todo.deletedAt, null);
  assert.deepEqual((await getState(db, { ...admin, userId: 'colleague' })).state.manualTasks, [todo]);
  const clientState = (await getState(db, store)).state;
  assert.equal(clientState.manualTasks, undefined);
  assert.equal(JSON.stringify(clientState).includes('联系司机'), false);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM notification_events WHERE tenant_id = ?').bind(admin.tenantId).first()).n, 0);
});

test('manual todo deadline edits persist without changing completed state or other task fields', async () => {
  const {admin,store}=await setup('manual-todo-deadline');
  const task=(await executeCommand(db,admin,command('addManualTask',[{title:'确认到货',note:'保留备注',dueDate:'2026-10-25'}]))).result;
  const completed=(await executeCommand(db,admin,command('setManualTaskDone',[task.id,true]))).result;
  const updated=(await executeCommand(db,admin,command('setManualTaskDueDate',[task.id,'2026-10-28']))).result;
  assert.equal(updated.dueDate,'2026-10-28');assert.equal(updated.completedAt,completed.completedAt);assert.equal(updated.note,task.note);assert.equal(updated.source,'manual');
  const snapshot=await loadState(db,admin.tenantId);
  for(const date of ['',null,'2026-02-29','2026-4-1'])await assert.rejects(executeCommand(db,admin,command('setManualTaskDueDate',[task.id,date])),{status:400});
  await assert.rejects(executeCommand(db,store,command('setManualTaskDueDate',[task.id,'2026-10-27'])),{status:403});
  await assert.rejects(executeCommand(db,admin,command('addManualTask',[{title:'缺少日期'}])),{status:400});
  assert.deepEqual(await loadState(db,admin.tenantId),snapshot);
  assert.equal((await getState(db,admin)).state.manualTasks[0].dueDate,'2026-10-28');
});

test('manual todo completion and deletion retain content and can be undone', async () => {
  const { admin } = await setup('manual-todo-lifecycle');
  const todo = (await executeCommand(db, admin, command('addManualTask', [{ title: '确认采购', note: '保留此记录', dueDate: '2026-10-24' }]))).result;
  const done = (await executeCommand(db, admin, command('setManualTaskDone', [todo.id, true]))).result;
  assert.ok(Date.parse(done.completedAt)); assert.equal(done.note, todo.note);
  const same = (await executeCommand(db, admin, command('setManualTaskDone', [todo.id, true]))).result;
  assert.equal(same.completedAt, done.completedAt);
  const reopened = (await executeCommand(db, admin, command('setManualTaskDone', [todo.id, false]))).result;
  assert.equal(reopened.completedAt, null);
  const removed = (await executeCommand(db, admin, command('deleteManualTask', [todo.id]))).result;
  assert.ok(Date.parse(removed.deletedAt)); assert.equal(removed.note, todo.note);
  const beforeInvalid = await loadState(db, admin.tenantId);
  await assert.rejects(executeCommand(db, admin, command('setManualTaskDone', [todo.id, true])), /手动待办不存在/);
  assert.deepEqual(await loadState(db, admin.tenantId), beforeInvalid);
  const restored = (await executeCommand(db, admin, command('restoreManualTask', [todo.id]))).result;
  assert.equal(restored.deletedAt, null); assert.equal(restored.completedAt, null);
  assert.equal(restored.createdAt, todo.createdAt); assert.equal(restored.title, todo.title);
  assert.equal(restored.dueDate, '2026-10-24');
});

test('manual todo commands reject stores, foreign IDs and forged source or author fields', async () => {
  const a = await setup('manual-todo-acl-a'), b = await setup('manual-todo-acl-b');
  const todo = (await executeCommand(db, a.admin, command('addManualTask', [{ title: '厨房 A 待办', dueDate: '2026-10-25' }]))).result;
  const before = await loadState(db, a.admin.tenantId);
  for (const type of ['addManualTask', 'setManualTaskDone', 'setManualTaskDueDate', 'deleteManualTask', 'restoreManualTask']) {
    const args = type === 'addManualTask' ? [{ title: '伪造事项' }] : type === 'setManualTaskDone' ? [todo.id, true] : type === 'setManualTaskDueDate' ? [todo.id, '2026-10-25'] : [todo.id];
    await assert.rejects(executeCommand(db, a.store, command(type, args)), { status: 403 });
  }
  for (const field of ['source', 'createdBy', 'tenantId', 'completedAt', 'id']) {
    await assert.rejects(executeCommand(db, a.admin, command('addManualTask', [{ title: '伪造事项', [field]: 'forged' }])), { status: 400 });
  }
  for (const type of ['setManualTaskDone', 'setManualTaskDueDate', 'deleteManualTask', 'restoreManualTask']) {
    await assert.rejects(executeCommand(db, b.admin, command(type, type === 'setManualTaskDone' ? [todo.id, true] : type === 'setManualTaskDueDate' ? [todo.id, '2026-10-25'] : [todo.id])), /手动待办不存在/);
  }
  assert.deepEqual(await loadState(db, a.admin.tenantId), before);
  assert.deepEqual((await getState(db, b.admin)).state.manualTasks, []);
});

test('manual todo validation rejects invalid input without altering the saved snapshot', async () => {
  const { admin } = await setup('manual-todo-validation');
  const before = await loadState(db, admin.tenantId);
  for (const value of [null, [], {}, { title: '  ' }, { title: '\u0000\u0001' }, { title: 12 }, { title: 'x'.repeat(121) }, { title: 'title', note: 'x'.repeat(501) }, { title: 'title', note: {} }]) {
    await assert.rejects(executeCommand(db, admin, command('addManualTask', [value])), { status: 400 });
  }
  for (const dueDate of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-10-20T00:00:00Z', '2026-1-2', ' 2026-10-20 ', 20261020, {}]) {
    await assert.rejects(executeCommand(db, admin, command('addManualTask', [{ title: '确认日期', dueDate }])), { status: 400 });
  }
  await assert.rejects(executeCommand(db, admin, command('setManualTaskDone', ['todo-1', 'true'])), { status: 400 });
  await assert.rejects(executeCommand(db, admin, command('addManualTask', [{ title: 'title' }, 'extra'])), { status: 400 });
  assert.deepEqual(await loadState(db, admin.tenantId), before);
});

test('concurrent manual todo retries create once and separate additions do not overwrite each other', async () => {
  const { admin } = await setup('manual-todo-race');
  const retry = command('addManualTask', [{ title: '检查冷库', dueDate: '2026-10-25' }]);
  const responses = await Promise.all([executeCommand(db, admin, retry), executeCommand(db, admin, retry)]);
  assert.equal(new Set(responses.map(response => response.result.id)).size, 1);
  assert.equal(responses.filter(response => response.replayed).length, 1);
  await Promise.all([
    executeCommand(db, admin, command('addManualTask', [{ title: '联系配送', dueDate: '2026-10-25' }])),
    executeCommand(db, { ...admin, userId: 'colleague' }, command('addManualTask', [{ title: '整理库存', dueDate: '2026-10-25' }])),
  ]);
  const final = await loadState(db, admin.tenantId);
  assert.equal(final.state.manualTasks.length, 3); assert.equal(final.revision, 3);
  assert.deepEqual(final.state.manualTasks.map(todo => todo.title).sort(), ['检查冷库', '联系配送', '整理库存'].sort());
});

test('failed manual todo saves roll back data, revision and retry key together', async () => {
  const { admin } = await setup('manual-todo-failure');
  const before = await loadState(db, admin.tenantId);
  await db.exec("CREATE TRIGGER fail_manual_todo_test BEFORE INSERT ON business_audit_log WHEN NEW.tenant_id = 'manual-todo-failure' BEGIN SELECT RAISE(ABORT, 'manual_todo_test_failure'); END;");
  const request = command('addManualTask', [{ title: '需要成功保存的待办', dueDate: '2026-10-25' }]);
  await assert.rejects(executeCommand(db, admin, request), /manual_todo_test_failure/);
  assert.deepEqual(await loadState(db, admin.tenantId), before);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM command_idempotency WHERE tenant_id = ?').bind(admin.tenantId).first()).n, 0);
  await db.exec('DROP TRIGGER fail_manual_todo_test');
  await executeCommand(db, admin, request);
  assert.equal((await getState(db, admin)).state.manualTasks.length, 1);
});

test('production seed drops prototype orders, stores entities independently and never overwrites a tenant', async () => {
  const model = new KitchenModel();
  model.addManualTask({ title: '本地预览的私有待办', dueDate: '2026-10-25' });
  await seedTenant(db, { tenantId: 'seed-test', state: model.state });
  const loaded = await loadState(db, 'seed-test');
  assert.equal(loaded.state.orders.length, 0);
  assert.deepEqual(loaded.state.manualTasks, []);
  assert.equal(loaded.state.products.length, model.state.products.length);
  assert.equal(loaded.state.stores.some(store => store.isDemoAccount), false);
  const core = JSON.parse((await db.prepare('SELECT core_json FROM tenants WHERE id = ?').bind('seed-test').first()).core_json);
  assert.equal(core.products, undefined);
  assert.equal(core.orders, undefined);
  assert.equal(core.documents, undefined);
  await assert.rejects(seedTenant(db, { tenantId: 'seed-test', state: model.state }), /UNIQUE/);
});

test('store snapshots isolate prices, documents, sources, private costs and orderable stock', async () => {
  const { admin, store, pid } = await setup('visibility');
  await executeCommand(db, admin, command('setStoreAllocation', ['store-a', pid, 2]));
  await executeCommand(db, admin, command('setStoreAllocation', ['store-b', pid, 3]));
  const loaded = await getState(db, store);
  assert.deepEqual(loaded.state.stores.map(item => item.id), ['store-a']);
  assert.deepEqual(Object.keys(loaded.state.prices), ['store-a']);
  assert.equal(loaded.state.inventory[pid], 2);
  assert.deepEqual(loaded.state.storeAllocations, {});
  assert.equal(loaded.state.products[0].basePrice, null);
  assert.equal(loaded.state.products[0].referencePrice, undefined);
  assert.equal(loaded.state.products[0].costReferences, undefined);
  assert.equal(loaded.state.products[0].source, undefined);
  assert.equal(loaded.state.privateMaterials, undefined);
  assert.equal(JSON.stringify(loaded).includes('private-supplier'), false);
  const client = new KitchenModel();
  client.state = loaded.state;
  assert.equal(client.getOrderableStock('store-a', pid), 2);
  assert.equal(client.getUnitOrderableStock('store-a', pid, 'KG'), 30);
  await assert.rejects(getPrivateMaterials(db, store), { status: 403 });
  assert.equal((await getPrivateMaterials(db, admin)).materialCosts[0].cost, 1);
  await assert.rejects(executeCommand(db, store, command('setPrice', ['store-a', pid, 1])), { status: 403 });
  await assert.rejects(executeCommand(db, store, command('submitOrder', ['store-b', { [pid]: 1 }, tokyoToday()])), { status: 403 });
});

test('a multi-unit order saves authoritative prices and stock atomically, and is idempotent', async () => {
  const { admin, store, pid } = await setup('orders');
  await executeCommand(db, admin, command('setStoreUnitAllocation', ['store-a', pid, 'KG', 30]));
  const request = command('submitOrder', ['store-a', { [pid]: 7.5 }, tokyoToday(), '请冷冻配送', { [pid]: 'KG' }], {
    expectedQuotes: { [pid]: { price: 120, taxBasis: 'exclusive', taxRate: 0.08, unit: 'KG', perBase: 15 } },
  });
  const first = await executeCommand(db, store, request);
  assert.equal(first.result.items[0].baseQty, 0.5);
  assert.equal(first.result.items[0].price, 120);
  assert.equal(first.result.items[0].quoteSource, undefined);
  assert.equal(first.result.date, tokyoToday());
  assert.equal(first.result.isDemo, false);
  assert.equal(first.result.origin, 'cloud');
  const repeated = await executeCommand(db, store, request);
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.result.id, first.result.id);
  assert.equal(repeated.revision, first.revision);
  const all = await loadState(db, admin.tenantId);
  assert.equal(all.state.inventory[pid], 9.5);
  assert.equal(all.state.storeAllocations['store-a'][pid], 1.5);
  assert.equal(all.state.orders.length, 1);
  await assert.rejects(executeCommand(db, store, { ...request, args: ['store-a', { [pid]: 1 }, tokyoToday()] }), { code: 'IDEMPOTENCY_CONFLICT' });
  const audit = await db.prepare('SELECT count(*) AS count FROM business_audit_log WHERE tenant_id = ?').bind(admin.tenantId).first();
  assert.equal(audit.count, 2);
});

test('concurrent orders cannot oversell stock and conflicting batches do not lose writes', async () => {
  const { admin, store, pid } = await setup('concurrency');
  await executeCommand(db, admin, command('setWarehouseStock', [pid, 1]));
  const other = { ...store, userId: 'store-b-concurrency', storeId: 'store-b' };
  const outcomes = await Promise.allSettled([
    executeCommand(db, store, command('submitOrder', ['store-a', { [pid]: 1 }, tokyoToday()])),
    executeCommand(db, other, command('submitOrder', ['store-b', { [pid]: 1 }, tokyoToday()])),
  ]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(value => value.status === 'rejected').reason.message, /库存不足/);
  const final = await loadState(db, admin.tenantId);
  assert.equal(final.state.inventory[pid], 0);
  assert.equal(final.state.orders.length, 1);
  assert.equal(final.revision, 2);
  assert.equal((await db.prepare('SELECT count(*) AS count FROM business_write_assertion').first()).count, 0);
});

test('simultaneous retries create exactly one order with one deduction', async () => {
  const { store, pid } = await setup('retry');
  const request = command('submitOrder', ['store-a', { [pid]: 1 }, tokyoToday()]);
  const outcomes = await Promise.all([executeCommand(db, store, request), executeCommand(db, store, request)]);
  assert.equal(new Set(outcomes.map(value => value.result.id)).size, 1);
  assert.equal(outcomes.filter(value => value.replayed).length, 1);
  const final = await loadState(db, store.tenantId);
  assert.equal(final.state.inventory[pid], 9);
  assert.equal(final.state.orders.length, 1);
  assert.equal(final.revision, 1);
});

test('tenant isolation survives matching product, store, user and idempotency identifiers', async () => {
  const first = await setup('tenant-a');
  const second = await setup('tenant-b');
  const key = crypto.randomUUID();
  await executeCommand(db, { ...first.admin, userId: 'same-admin' }, command('setPrice', ['store-a', first.pid, 77], { idempotencyKey: key }));
  await executeCommand(db, { ...second.admin, userId: 'same-admin' }, command('setPrice', ['store-a', second.pid, 88], { idempotencyKey: key }));
  assert.equal((await getState(db, first.store)).state.prices['store-a'][first.pid], 77);
  assert.equal((await getState(db, second.store)).state.prices['store-a'][second.pid], 88);
});

test('stale quotes, mixed-unit carts and oversized inputs reject before any database mutation', async () => {
  const { admin, store, pid } = await setup('validation');
  const before = await loadState(db, store.tenantId);
  await assert.rejects(executeCommand(db, store, command('submitOrder', ['store-a', { [pid]: 1 }, tokyoToday(), '', { [pid]: 'KG' }], {
    expectedQuotes: { [pid]: { price: 99, unit: 'KG' } },
  })), { code: 'QUOTE_CHANGED' });
  await assert.rejects(executeCommand(db, store, command('submitOrder', ['store-a', { [pid]: { KG: 1, 箱: 1 } }, tokyoToday()])), /一种单位/);
  await assert.rejects(executeCommand(db, admin, command('addProduct', [{ name: 'x'.repeat(121), category: '冷冻品', unit: '箱' }])), /最多/);
  await assert.rejects(executeCommand(db, admin, command('addProduct', [{ name: '其他', category: '冷冻品', unit: '吨' }])), /有效计价单位/);
  await assert.rejects(executeCommand(db, admin, JSON.parse('{"type":"setWarehouseStock","args":["__proto__",1],"idempotencyKey":"bad-key","__proto__":{}}')), /字段/);
  assert.deepEqual(await loadState(db, store.tenantId), before);
});

test('packing and delivery preserve validation, with store-scoped issues and confirmation', async () => {
  const { admin, store, pid } = await setup('delivery');
  const { result: order } = await executeCommand(db, store, command('submitOrder', ['store-a', { [pid]: 1 }, tokyoToday()]));
  const other = { ...store, storeId: 'store-b' };
  await assert.rejects(executeCommand(db, other, command('recordIssue', [order.id, 'unknown'])), { status: 404 });
  await executeCommand(db, store, command('recordIssue', [order.id, '请检查外包装']));
  await assert.rejects(executeCommand(db, admin, command('setStage', [order.id, 'ready'])), /顺序/);
  await executeCommand(db, admin, command('packLine', [order.id, pid, 1]));
  await executeCommand(db, admin, command('confirmPackLine', [order.id, pid]));
  await executeCommand(db, admin, command('setStage', [order.id, 'ready']));
  await executeCommand(db, admin, command('setStage', [order.id, 'delivering']));
  const delivered = await executeCommand(db, store, command('confirmDelivery', [order.id, '张店长']));
  assert.equal(delivered.result.stage, 'delivered');
  assert.equal(delivered.result.receivedBy, '张店长');
  assert.ok(delivered.result.deliveredAt);
  await assert.rejects(executeCommand(db, store, command('confirmDelivery', [order.id, '其他人'])), { code: 'ALREADY_DELIVERED' });
  await assert.rejects(executeCommand(db, store, command('remindOrder', [order.id])), /已送达/);
});

test('many-line orders use bounded SQL statements rather than a write per item', async () => {
  const { admin, store } = await setup('many-lines');
  const state = initialState();
  const model = new KitchenModel(); model.state = state; model.save = () => {};
  for (let i = 0; i < 41; i++) model.addProduct({ name: `食材 ${i}`, category: '冷冻品', unit: '袋', stock: 10, basePrice: 100 });
  await seedTenant(db, { tenantId: 'forty-two-lines', state });
  let batchSize = 0;
  let prepareCount = 0;
  const counted = {
    prepare(...args) { prepareCount++; return db.prepare(...args); },
    async batch(statements) { batchSize = Math.max(batchSize, statements.length); return db.batch(statements); },
  };
  const request = command('submitOrder', ['store-a', Object.fromEntries(state.products.map(product => [product.id, 1])), tokyoToday()], {
    expectedQuotes: Object.fromEntries(state.products.map(product => [product.id, { price: product.basePrice, taxBasis: 'unspecified', taxRate: null, unit: product.unit, perBase: 1 }])),
  });
  const response = await executeCommand(counted, { ...store, tenantId: 'forty-two-lines' }, request);
  assert.equal(response.result.items.length, 42);
  assert.ok(batchSize <= 10);
  assert.ok(prepareCount < 20);
});

test('imports reject all rows atomically and cached results remain bound to the same store', async () => {
  const { admin, store, pid } = await setup('imports');
  const before = await loadState(db, admin.tenantId);
  await assert.rejects(executeCommand(db, admin, command('importProducts', [[
    { name: '新食材', category: '冷冻品', unit: '袋', stock: 5, basePrice: 100 },
    { name: '牛骨', category: '冷冻品', unit: '箱', spec: '15KG/箱', stock: 1, basePrice: 100 },
  ]])), /已存在/);
  assert.deepEqual(await loadState(db, admin.tenantId), before);
  const added = await executeCommand(db, admin, command('importProducts', [[{ name: '新食材', category: '冷冻品', unit: '袋', stock: 5, basePrice: 100 }]]));
  assert.equal(added.result.length, 1);
  assert.equal(added.state.products.length, 2);
  const { result: order } = await executeCommand(db, store, command('submitOrder', ['store-a', { [pid]: 1 }, tokyoToday()]));
  const issue = command('recordIssue', [order.id, '请核对']);
  await executeCommand(db, store, issue);
  await assert.rejects(executeCommand(db, { ...store, storeId: 'store-b' }, issue), { status: 403 });
});

test('completed history is bounded but active orders are never silently truncated', async () => {
  const state = initialState();
  state.orders = Array.from({ length: 105 }, (_, i) => ({ id: `done-${i}`, storeId: 'store-a', stage: 'delivered', submittedAt: new Date(1700000000000 + i * 1000).toISOString(), items: [], isDemo: false }));
  await seedTenant(db, { tenantId: 'history', state });
  const loaded = await loadState(db, 'history');
  assert.equal(loaded.state.orders.length, 100);
  assert.equal(loaded.state.orders[0].id, 'done-104');
  const active = Array.from({ length: 1001 }, (_, i) => ({ id: `active-${i}`, storeId: 'store-a', stage: 'pending', submittedAt: new Date().toISOString(), items: [] }));
  await db.prepare(`INSERT INTO orders (tenant_id, id, store_id, stage, data_json, created_at)
    SELECT 'history', json_extract(value, '$.id'), 'store-a', 'pending', value, json_extract(value, '$.submittedAt') FROM json_each(?)`).bind(JSON.stringify(active)).run();
  await assert.rejects(loadState(db, 'history'), { code: 'ACTIVE_ORDER_LIMIT' });
});

test('two-sided unit equations and unit-based stock persist through the cloud command boundary', async () => {
  const {admin,store,pid}=await setup('equations-release');
  const equations=[{fromQty:30,fromUnit:'KG',toQty:2,toUnit:'箱'}];
  await executeCommand(db,admin,command('setSaleUnitEquations',[pid,equations]));
  const updated=await executeCommand(db,admin,command('setWarehouseUnitStock',[pid,'KG',1]));
  assert.deepEqual(updated.state.products.find(p=>p.id===pid).saleUnitEquations,equations);
  const scoped=await getState(db,store);
  assert.equal(scoped.state.products.find(p=>p.id===pid).saleUnits.find(u=>u.unit==='KG').perBase,15);
  assert.ok(Math.abs(scoped.state.inventory[pid]*15-1)<1e-10);
  await assert.rejects(executeCommand(db,store,command('setSaleUnitEquations',[pid,equations])),error=>error.status===403);
});

test('new stores use validated Japanese address hierarchy without a manual ordering account', async () => {
  const {admin}=await setup('store-address-release');
  const details={name:'大阪测试门店',prefectureCode:'27',municipalityCode:'27100',wardCode:'27111',addressDetail:'難波中1丁目2番3号',contact:'采购员',phone:'090-1234-5678',address:'forged'};
  const result=await executeCommand(db,admin,command('addStore',[details]));
  assert.equal(result.result.address,'大阪府大阪市浪速区難波中1丁目2番3号');
  assert.equal(result.result.prefecture,'大阪府');assert.equal(result.result.accessCode,undefined);
  await assert.rejects(executeCommand(db,admin,command('addStore',[{...details,prefectureCode:'13'}])),error=>error.status===400);
});

test('recycling persists through D1 and restores product metadata, units, stock and quotes', async () => {
  const { admin, store, pid } = await setup('recycle-persistence');
  await executeCommand(db, admin, command('setStoreAllocation', ['store-a', pid, 2]));
  const before = await loadState(db, admin.tenantId);
  const request = command('deleteProduct', [pid]);
  const deleted = await executeCommand(db, admin, request);
  assert.ok(deleted.result.deletedAt);
  const repeated = await executeCommand(db, admin, request);
  assert.equal(repeated.replayed, true);
  assert.equal(repeated.revision, deleted.revision);
  const persisted = await loadState(db, admin.tenantId);
  assert.equal(persisted.state.products[0].deletedAt, deleted.result.deletedAt);
  assert.deepEqual(persisted.state.inventory, before.state.inventory);
  assert.deepEqual(persisted.state.storeAllocations, before.state.storeAllocations);
  assert.deepEqual(persisted.state.unitQuotes, before.state.unitQuotes);
  assert.deepEqual(persisted.state.prices, before.state.prices);

  const scoped = await getState(db, store);
  const client = Object.create(KitchenModel.prototype);
  client.state = scoped.state;
  assert.equal(client.getProducts().length, 0);
  assert.equal(client.getProduct(pid), undefined);
  assert.deepEqual(scoped.state.inventory, {});
  assert.deepEqual(scoped.state.prices[store.storeId], {});
  assert.deepEqual(scoped.state.quoteMeta[store.storeId], {});
  assert.deepEqual(scoped.state.unitQuotes[store.storeId], {});
  await assert.rejects(executeCommand(db, store, command('submitOrder', [store.storeId, { [pid]: 1 }, tokyoToday()])), /回收站/);
  await assert.rejects(executeCommand(db, admin, command('addProduct', [{ name: '牛骨', category: '冷冻品', unit: '箱', spec: '15KG/箱' }])), /回收站/);

  const restoreRequest = command('restoreProduct', [pid]);
  const restored = await executeCommand(db, admin, restoreRequest);
  assert.equal(restored.result.deletedAt, undefined);
  assert.equal((await executeCommand(db, admin, restoreRequest)).replayed, true);
  const after = await loadState(db, admin.tenantId);
  assert.deepEqual(after.state.products, before.state.products);
  assert.deepEqual(after.state.inventory, before.state.inventory);
  assert.deepEqual(after.state.storeAllocations, before.state.storeAllocations);
  assert.deepEqual(after.state.unitQuotes, before.state.unitQuotes);
  assert.deepEqual(after.state.prices, before.state.prices);
  client.state = (await getState(db, store)).state;
  assert.equal(client.getProducts().length, 1);
  assert.equal(client.getUnitOrderableStock(store.storeId, pid, 'KG'), 30);
});

test('recycling is admin-only and tenant-scoped while existing orders remain deliverable', async () => {
  const { admin, store, pid } = await setup('recycle-orders');
  const otherTenant = await setup('recycle-other-tenant');
  const { result: order } = await executeCommand(db, store, command('submitOrder', [store.storeId, { [pid]: 1 }, tokyoToday()]));
  const beforeRejected = await loadState(db, admin.tenantId);
  await assert.rejects(executeCommand(db, store, command('deleteProduct', [pid])), { status: 403 });
  await assert.rejects(executeCommand(db, store, command('restoreProduct', [pid])), { status: 403 });
  await assert.rejects(executeCommand(db, admin, command('deleteProduct', ['missing-product'])), /商品不存在/);
  await assert.rejects(executeCommand(db, admin, command('restoreProduct', ['__proto__'])), /商品不正确/);
  await assert.rejects(executeCommand(db, admin, command('deleteProduct', [pid, 'unexpected'])), /参数不正确/);
  assert.deepEqual(await loadState(db, admin.tenantId), beforeRejected);

  await executeCommand(db, admin, command('deleteProduct', [pid]));
  assert.equal((await getState(db, otherTenant.admin)).state.products[0].deletedAt, undefined);
  const scoped = await getState(db, store);
  assert.equal(scoped.state.orders[0].items[0].productId, pid);
  assert.equal(scoped.state.products.find(product => product.id === pid).name, '牛骨');
  assert.ok(scoped.state.products.find(product => product.id === pid).deletedAt);
  assert.equal(scoped.state.inventory[pid], 0);
  const otherStore = await getState(db, { ...store, userId: 'other-store-user', storeId: 'store-b' });
  assert.equal(otherStore.state.products.some(product => product.id === pid), false);
  assert.equal(otherStore.state.prices['store-b'][pid], undefined);
  await executeCommand(db, admin, command('packLine', [order.id, pid, 1]));
  await executeCommand(db, admin, command('confirmPackLine', [order.id, pid]));
  await executeCommand(db, admin, command('setStage', [order.id, 'ready']));
  await executeCommand(db, admin, command('setStage', [order.id, 'delivering']));
  const delivered = await executeCommand(db, store, command('confirmDelivery', [order.id, '测试店长']));
  assert.equal(delivered.result.stage, 'delivered');
  const restored = await executeCommand(db, admin, command('restoreProduct', [pid]));
  assert.equal(restored.state.inventory[pid], 9);
  assert.equal(restored.state.products[0].deletedAt, undefined);
  assert.equal(restored.state.orders[0].stage, 'delivered');
});

test('store updates persist photo and address without replacing codes, quotes or identity', async () => {
  const { admin, store } = await setup('store-edit');
  const details = { name: '大阪门店', prefectureCode: '27', municipalityCode: '27100', wardCode: '27111', addressDetail: '難波中1丁目2番3号', contact: '店长', phone: '090-1234-5678', image: '/api/images/12345678-1234-1234-1234-123456789abc' };
  const { result: added } = await executeCommand(db, admin, command('addStore', [details]));
  const snapshot = await loadState(db, admin.tenantId);
  const changes = { ...details, name: '修改后门店', contact: '新店长', image: '/api/images/abcdefab-abcd-abcd-abcd-abcdefabcdef' };
  const request = command('updateStore', [added.id, changes]);
  const edited = await executeCommand(db, admin, request);
  assert.equal(edited.result.id, added.id);
  assert.equal(edited.result.name, changes.name);
  assert.equal(edited.result.image, changes.image);
  assert.equal(edited.result.address, '大阪府大阪市浪速区難波中1丁目2番3号');
  assert.equal(edited.result.prefectureCode, '27');
  assert.deepEqual(edited.state.prices, snapshot.state.prices);
  assert.deepEqual(edited.state.orders, snapshot.state.orders);
  assert.equal((await executeCommand(db, admin, request)).replayed, true);
  assert.equal((await getState(db, { ...store, storeId: added.id })).state.stores[0].image, changes.image);
  await assert.rejects(executeCommand(db, store, command('updateStore', [added.id, changes])), { status: 403 });
  await assert.rejects(executeCommand(db, admin, command('updateStore', [added.id, { ...changes, image: 'https://example.com/fake.jpg' }])), /必须先上传/);
  await assert.rejects(executeCommand(db, admin, command('updateStore', [added.id, { ...changes, municipalityCode: '13104' }])), /请选择/);
});

test('deleting a store revokes all logins atomically and retains its order history', async () => {
  const { admin, store, pid } = await setup('store-delete');
  await executeCommand(db, admin, command('setStoreAllocation', [store.storeId, pid, 4]));
  const { result: order } = await executeCommand(db, store, command('submitOrder', [store.storeId, { [pid]: 1 }, tokyoToday()]));
  await db.prepare("INSERT INTO users (id, tenant_id, role, store_id, display_name, active, created_at) VALUES (?, ?, 'store', ?, '店长', 1, 0)").bind(store.userId, store.tenantId, store.storeId).run();
  await db.prepare('INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, 9999999999)').bind('store-session', store.userId).run();
  await db.prepare("INSERT INTO invites (hash, tenant_id, store_id, role, display_name, expires) VALUES (?, ?, ?, 'store', '备用', 9999999999)").bind('store-invite', store.tenantId, store.storeId).run();
  const before = await loadState(db, admin.tenantId);
  await assert.rejects(executeCommand(db, store, command('deleteStore', [store.storeId])), { status: 403 });
  const request = command('deleteStore', [store.storeId]);
  const deleted = await executeCommand(db, admin, request);
  assert.ok(deleted.result.deletedAt);
  assert.deepEqual(deleted.state.inventory, before.state.inventory);
  assert.equal(deleted.state.storeAllocations[store.storeId], undefined);
  assert.deepEqual(deleted.state.orders, before.state.orders);
  assert.deepEqual(deleted.state.prices, before.state.prices);
  assert.equal(deleted.state.stores.find(item => item.id === store.storeId).name, '门店 A');
  assert.equal((await db.prepare('SELECT active FROM users WHERE id = ?').bind(store.userId).first()).active, 0);
  assert.equal(await db.prepare('SELECT hash FROM sessions WHERE user_id = ?').bind(store.userId).first(), null);
  assert.equal(await db.prepare('SELECT hash FROM invites WHERE tenant_id = ? AND store_id = ?').bind(store.tenantId, store.storeId).first(), null);
  assert.equal((await executeCommand(db, admin, request)).replayed, true);
  await assert.rejects(getState(db, store), { status: 403 });
  await assert.rejects(executeCommand(db, store, command('submitOrder', [store.storeId, { [pid]: 1 }, tokyoToday()])), { status: 403 });
  await executeCommand(db, admin, command('packLine', [order.id, pid, 1]));
  await executeCommand(db, admin, command('confirmPackLine', [order.id, pid]));
  await executeCommand(db, admin, command('setStage', [order.id, 'ready']));
  await executeCommand(db, admin, command('setStage', [order.id, 'delivering']));
  assert.equal((await executeCommand(db, admin, command('setStage', [order.id, 'delivered']))).result.stage, 'delivered');
});

test('packing requires explicit admin confirmation and rejects partial or changed quantities', async () => {
  const { admin, store, pid } = await setup('packing-confirm');
  const { result: order } = await executeCommand(db, store, command('submitOrder', [store.storeId, { [pid]: 2 }, tokyoToday()]));
  await assert.rejects(executeCommand(db, admin, command('confirmPackLine', [order.id, pid])), /尚未补全/);
  await executeCommand(db, admin, command('packLine', [order.id, pid, 1]));
  await assert.rejects(executeCommand(db, admin, command('confirmPackLine', [order.id, pid])), /尚未补全/);
  await executeCommand(db, admin, command('packLine', [order.id, pid, 2]));
  await assert.rejects(executeCommand(db, admin, command('setStage', [order.id, 'ready'])), /未配齐/);
  await assert.rejects(executeCommand(db, store, command('confirmPackLine', [order.id, pid])), { status: 403 });
  const request = command('confirmPackLine', [order.id, pid]);
  const confirmed = await executeCommand(db, admin, request);
  assert.equal(confirmed.result.items[0].packingConfirmed, true);
  assert.equal((await executeCommand(db, admin, request)).replayed, true);
  assert.equal((await getState(db, store)).state.orders[0].items[0].packingConfirmed, true);
  await executeCommand(db, admin, command('packLine', [order.id, pid, 1]));
  assert.equal((await getState(db, store)).state.orders[0].items[0].packingConfirmed, false);
  await executeCommand(db, admin, command('packLine', [order.id, pid, 2]));
  await executeCommand(db, admin, command('confirmPackLine', [order.id, pid]));
  await executeCommand(db, admin, command('setStage', [order.id, 'ready']));
});

test('packing checklist is atomic, retryable and scoped, with persisted private line notes', async () => {
  const { admin, store, pid } = await setup('packing-checklist');
  const other = await setup('packing-other-tenant');
  const { result: order } = await executeCommand(db, store, command('submitOrder', [store.storeId, { [pid]: 2 }, tokyoToday()]));
  const inventory = (await getState(db, admin)).state.inventory;
  await assert.rejects(executeCommand(db, store, command('setPackLineDone', [order.id, pid, true])), { status: 403 });
  await assert.rejects(executeCommand(db, store, command('setPackingNote', [order.id, pid, '越权备注'])), { status: 403 });
  await assert.rejects(executeCommand(db, other.admin, command('setPackLineDone', [order.id, pid, true])), { status: 404 });
  await assert.rejects(executeCommand(db, other.admin, command('setPackingNote', [order.id, pid, '越权备注'])), { status: 404 });
  await assert.rejects(executeCommand(db, admin, command('setPackLineDone', [order.id, pid, 2])), /有效的配货状态/);
  await assert.rejects(executeCommand(db, admin, command('setPackLineDone', [order.id, pid, true, 20])), /参数不正确/);
  await assert.rejects(executeCommand(db, admin, command('setPackingNote', [order.id, pid, null])), /有效文字/);
  await assert.rejects(executeCommand(db, admin, command('setPackingNote', [order.id, pid, 'a'.repeat(1001)])), /最多 1000 字/);

  const completeRequest = command('setPackLineDone', [order.id, pid, true]);
  // Concurrent updates must retain both the checklist state and the note.
  await Promise.all([
    executeCommand(db, admin, completeRequest),
    executeCommand(db, admin, command('setPackingNote', [order.id, pid, '  缺货已补齐  '])),
  ]);
  assert.equal((await executeCommand(db, admin, completeRequest)).replayed, true);
  await executeCommand(db, admin, command('setPackLineDone', [order.id, pid, true]));
  const saved = await getState(db, admin);
  assert.equal(saved.state.orders[0].stage, 'packing');
  assert.equal(saved.state.orders[0].items[0].packedQty, 2);
  assert.equal(saved.state.orders[0].items[0].packingConfirmed, true);
  assert.equal(saved.state.orders[0].items[0].packingNote, '缺货已补齐');
  assert.deepEqual(saved.state.inventory, inventory);
  const clientLine = (await getState(db, store)).state.orders[0].items[0];
  assert.equal(clientLine.packingNote, undefined);
  assert.equal(clientLine.packingConfirmed, true);

  const undone = await executeCommand(db, admin, command('setPackLineDone', [order.id, pid, false]));
  assert.equal(undone.result.items[0].packedQty, 0);
  assert.equal(undone.result.items[0].packingConfirmed, false);
  assert.equal(undone.result.items[0].packingNote, '缺货已补齐');
  await assert.rejects(executeCommand(db, admin, command('setStage', [order.id, 'ready'])), /未配齐/);
  await executeCommand(db, admin, command('setPackingNote', [order.id, pid, '']));
  assert.equal((await getState(db, admin)).state.orders[0].items[0].packingNote, undefined);
  await executeCommand(db, admin, command('setPackLineDone', [order.id, pid, true]));
  await executeCommand(db, admin, command('setStage', [order.id, 'ready']));
  await assert.rejects(executeCommand(db, admin, command('setPackLineDone', [order.id, pid, false])), /不能修改/);
  await assert.rejects(executeCommand(db, admin, command('setPackingNote', [order.id, pid, '不可修改'])), /不能修改/);
});

test('legacy stores support freeform edits and image removal without requiring missing original contact data', async () => {
  const { admin, store } = await setup('legacy-store-edit');
  const edit = await executeCommand(db, admin, command('updateStore', [store.storeId, { name: '原门店更名', image: '', city: '神户', address: '神戸市中央区元町通1丁目', contact: '', phone: '' }]));
  assert.equal(edit.result.name, '原门店更名');
  assert.equal(edit.result.image, null);
  assert.equal(edit.result.city, '神户');
  assert.equal(edit.result.address, '神戸市中央区元町通1丁目');
  assert.equal(edit.result.prefectureCode, '');
  await assert.rejects(executeCommand(db, admin, command('updateStore', [store.storeId, { phone: 'not a phone' }])), /联系电话/);
  for (const field of ['id', 'accessCode', 'account', 'deletedAt']) {
    await assert.rejects(executeCommand(db, admin, command('updateStore', [store.storeId, { [field]: 'forged' }])), /字段不正确/);
  }
});

test('store catalogue excludes unpriced items and other-store prices while retaining historical order metadata', async () => {
  const { admin, store, pid } = await setup('catalogue-visibility');
  const { result: hidden } = await executeCommand(db, admin, command('addProduct', [{name:'未上架食材', category:'冷冻品', unit:'袋', stock:10}]));
  await executeCommand(db, admin, command('setPrice', ['store-b', hidden.id, 900]));
  const own = (await getState(db, store)).state;
  assert.equal(own.products.some(p => p.id === hidden.id), false);
  assert.equal(own.prices['store-a'][hidden.id], undefined);
  assert.deepEqual(Object.keys(own.prices), ['store-a']);
  assert.equal((await getState(db, {...store, storeId:'store-b'})).state.products.some(p => p.id === hidden.id), true);
  await executeCommand(db, store, command('submitOrder', ['store-a', {[pid]:1}, tokyoToday(), '']));
  await executeCommand(db, admin, command('setSaleUnits', [pid, [{unit:'袋',perBase:2}]]));
  const historical = (await getState(db, store)).state;
  assert.equal(historical.products.find(p => p.id === pid).catalogueHidden, true);
  assert.equal(historical.orders[0].items[0].price, 1500);
  const client = Object.create(KitchenModel.prototype); client.state = historical;
  assert.deepEqual(client.getProducts(), []);
  assert.equal(client.getProduct(pid).name, '牛骨');
  await executeCommand(db, admin, command('setSaleUnits', [pid, [{unit:'袋',perBase:2},{unit:'KG',perBase:15}]]));
  const pricedUnit = (await getState(db, store)).state;
  client.state = pricedUnit; client.normalizeStoreCart('store-a');
  assert.equal(client.getCartUnit(pid), 'KG');
  assert.deepEqual(client.getQuotedSaleUnits('store-a', pid).map(u => u.unit), ['KG']);
  assert.equal(pricedUnit.unitQuotes['store-a'][pid].KG.source, null);
  assert.equal(pricedUnit.unitQuotes['store-a'][pid].KG.kind, 'listed');
});

test('report history pages past 100 orders without crossing tenants/stores or mixing revisions',async()=>{
  const {admin,store,pid}=await setup('report-history');
  const statements=Array.from({length:205},(_,i)=>{
    const order={id:`history-${i}`,storeId:i<202?'store-a':'store-b',stage:'delivered',deliveryDate:'2026-10-12',source:'private-path',items:[{productId:pid,qty:1,price:100,quoteSource:'private-source'}]};
    return db.prepare('INSERT INTO orders(tenant_id,id,store_id,stage,data_json,created_at) VALUES (?,?,?,?,?,?)').bind(admin.tenantId,order.id,order.storeId,order.stage,JSON.stringify(order),'2026-10-12');
  });
  await db.batch(statements);
  const state=await getState(db,admin);
  assert.equal(state.state.orders.length,100);
  const first=await getOrderHistory(db,admin,{revision:state.revision});
  const second=await getOrderHistory(db,admin,{revision:state.revision,cursor:first.nextCursor});
  const third=await getOrderHistory(db,admin,{revision:state.revision,cursor:second.nextCursor});
  assert.equal(new Set([...first.orders,...second.orders,...third.orders].map(order=>order.id)).size,205);
  assert.equal(third.nextCursor,null);
  const own=await getOrderHistory(db,store,{revision:state.revision});
  assert.ok(own.orders.every(order=>order.storeId===store.storeId));
  assert.equal(own.orders[0].source,undefined);
  assert.equal(own.orders[0].items[0].quoteSource,undefined);
  assert.equal(own.products[0].costReferences,undefined);
  assert.equal(own.products[0].basePrice,null);
  assert.equal(own.products[0].catalogueHidden,true);
  await assert.rejects(getOrderHistory(db,admin,{revision:state.revision+1}),{code:'HISTORY_CHANGED'});
  await assert.rejects(getOrderHistory(db,store,{revision:state.revision,cursor:-1}),{status:400});
});
