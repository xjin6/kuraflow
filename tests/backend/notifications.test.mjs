import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { KitchenModel } from '../../src/shared/data.js';
import { executeCommand, getState, loadState, seedTenant, tokyoToday } from '../../backend/repository.js';
import { listNotifications, markNotificationsRead, notificationStatements } from '../../backend/notifications.js';
import worker from '../../backend/worker.js';

let runtime, db;
const origin = 'https://notifications.kuraflow.test';
before(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'notifications-test', modules: true, script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-08', d1Databases: { DB: 'notifications-test' },
  }] }));
  db = await runtime.getD1Database('DB');
  for (const file of (await readdir(new URL('../../backend/migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL('../../backend/migrations/' + file, import.meta.url), 'utf8');
    await db.exec(sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' '));
  }
});
after(async () => runtime?.dispose());

async function setup(tenantId) {
  const model = new KitchenModel(); model.storage = null; model.save = () => model.state;
  model.state.products = []; model.state.orders = []; model.state.documents = []; model.state.inventory = {};
  model.state.prices = {}; model.state.quoteMeta = {}; model.state.reminders = [];
  model.state.stores = [{ id: 'store-a', name: '测试门店 A' }, { id: 'store-b', name: '测试门店 B' }];
  const product = model.addProduct({ name: '配货测试商品', category: '冷冻品', unit: '箱', stock: 20, basePrice: 100 });
  await seedTenant(db, { tenantId, state: model.state });
  return {
    admin: { tenantId, userId: 'admin-' + tenantId, role: 'admin', displayName: '管理人员' },
    otherAdmin: { tenantId, userId: 'member-' + tenantId, role: 'admin', displayName: '同事' },
    store: { tenantId, userId: 'store-' + tenantId, role: 'store', storeId: 'store-a', displayName: '门店人员' },
    product,
  };
}
const cmd = (type, args) => ({ type, args, idempotencyKey: crypto.randomUUID() });
async function submit(context, options = {}) {
  return executeCommand(db, context.admin, { ...cmd('submitOrder', ['store-a', { [context.product.id]: 1 }, tokyoToday(), '']), ...options });
}
const query = value => new URLSearchParams(value);
const count = async tenantId => (await db.prepare('SELECT count(*) AS n FROM notification_events WHERE tenant_id = ?').bind(tenantId).first()).n;
async function insertEvents(tenantId, size, { demo = false, prefix = crypto.randomUUID() } = {}) {
  const events = Array.from({ length: size }, (_, index) => ({
    eventKey: prefix + '-' + index, kind: 'order_submitted', title: '测试订单通知', body: '测试内容',
    targetType: 'order', targetId: 'archived-' + index, orderId: 'archived-' + index,
    isDemo: demo, createdAt: new Date().toISOString(), actorName: '测试人员',
  }));
  await db.batch(notificationStatements(db, tenantId, events));
}

test('initialization does not invent notification history; committed order and retries append one event', async () => {
  const context = await setup('notify-atomic');
  assert.equal((await listNotifications(db, context.admin)).items.length, 0);
  const request = cmd('submitOrder', ['store-a', { [context.product.id]: 1 }, tokyoToday()]);
  const responses = await Promise.all([executeCommand(db, context.admin, request), executeCommand(db, context.admin, request)]);
  assert.equal(responses.filter(result => result.replayed).length, 1);
  const page = await listNotifications(db, context.admin);
  assert.equal(page.items.length, 1); assert.equal(page.unreadCount, 1);
  assert.equal(page.items[0].kind, 'order_submitted');
  assert.equal(page.items[0].targetId, responses[0].result.id);
  assert.equal(page.items[0].read, false);
  assert.deepEqual(page.items[0].currentStatus, { label: '待配货', resolved: false });
  const core = JSON.parse((await db.prepare('SELECT core_json FROM tenants WHERE id = ?').bind(context.admin.tenantId).first()).core_json);
  assert.equal(core.notifications, undefined); assert.equal(core.notificationReads, undefined);
});

test('notification failure rolls back order, inventory, revision and idempotency together', async () => {
  const context = await setup('notify-rollback');
  await db.exec("CREATE TRIGGER fail_notification_test BEFORE INSERT ON notification_events WHEN NEW.tenant_id = 'notify-rollback' BEGIN SELECT RAISE(ABORT, 'notification_test_failure'); END;");
  const before = await loadState(db, context.admin.tenantId);
  const request = cmd('submitOrder', ['store-a', { [context.product.id]: 1 }, tokyoToday()]);
  await assert.rejects(executeCommand(db, context.admin, request), /notification_test_failure/);
  assert.deepEqual(await loadState(db, context.admin.tenantId), before);
  assert.equal(await count(context.admin.tenantId), 0);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM command_idempotency WHERE tenant_id = ?').bind(context.admin.tenantId).first()).n, 0);
  await db.exec('DROP TRIGGER fail_notification_test');
  await executeCommand(db, context.admin, request);
  assert.equal(await count(context.admin.tenantId), 1);
});

test('personal reads do not finish business work or change another administrator unread state', async () => {
  const context = await setup('notify-personal'); await submit(context);
  const before = await loadState(db, context.admin.tenantId);
  const page = await listNotifications(db, context.admin);
  assert.deepEqual(await markNotificationsRead(db, context.admin, { ids: [page.items[0].id] }), { unreadCount: 0 });
  assert.deepEqual(await markNotificationsRead(db, context.admin, { ids: [page.items[0].id] }), { unreadCount: 0 });
  assert.equal((await listNotifications(db, context.admin)).items[0].read, true);
  assert.equal((await listNotifications(db, context.admin, query({ filter: 'unread' }))).items.length, 0);
  assert.equal((await listNotifications(db, context.otherAdmin)).unreadCount, 1);
  assert.deepEqual(await loadState(db, context.admin.tenantId), before);
});

test('tenant scope and role reject foreign reads/marks without partial mutation', async () => {
  const a = await setup('notify-tenant-a'), b = await setup('notify-tenant-b');
  await submit(a); await submit(b);
  const own = (await listNotifications(db, a.admin)).items[0], foreign = (await listNotifications(db, b.admin)).items[0];
  assert.deepEqual((await listNotifications(db, a.admin, query({ tenantId: b.admin.tenantId, userId: b.admin.userId }))).items.map(item => item.id), [own.id]);
  await assert.rejects(markNotificationsRead(db, a.admin, { ids: [own.id, foreign.id] }), { status: 404 });
  assert.equal((await listNotifications(db, a.admin)).unreadCount, 1);
  for (const principal of [a.store, { ...a.admin, role: 'platform' }]) {
    await assert.rejects(listNotifications(db, principal), { status: 403 });
    await assert.rejects(markNotificationsRead(db, principal, { through: own.id }), { status: 403 });
  }
  await assert.rejects(listNotifications(db, null), { status: 401 });
});

test('pagination and demo filtering keep totals, unread counts and snapshot boundaries consistent', async () => {
  const context = await setup('notify-pages');
  await insertEvents(context.admin.tenantId, 54); await insertEvents(context.admin.tenantId, 2, { demo: true });
  const first = await listNotifications(db, context.admin);
  assert.equal(first.items.length, 50); assert.equal(first.unreadCount, 54); assert.equal(first.hasMore, true);
  assert.equal(first.items.some(item => item.isDemo), false); assert.equal(first.latestId, first.items[0].id);
  const next = await listNotifications(db, context.admin, query({ before: String(first.nextCursor) }));
  assert.equal(next.items.length, 4); assert.equal(next.hasMore, false); assert.equal(next.nextCursor, null);
  assert.equal(new Set([...first.items, ...next.items].map(item => item.id)).size, 54);
  assert.equal((await listNotifications(db, context.admin, query({ includeDemo: '1' }))).unreadCount, 56);
  await markNotificationsRead(db, context.admin, { through: first.latestId });
  assert.equal((await listNotifications(db, context.admin)).unreadCount, 0);
  assert.equal((await listNotifications(db, context.admin, query({ includeDemo: '1', filter: 'unread' }))).items.length, 2);
});

test('mark-all affects only the client snapshot and clamps forged future IDs before concurrent events arrive', async () => {
  const context = await setup('notify-boundary'); await insertEvents(context.admin.tenantId, 1);
  const snapshot = await listNotifications(db, context.admin);
  await insertEvents(context.admin.tenantId, 1);
  assert.equal((await markNotificationsRead(db, context.admin, { through: snapshot.latestId })).unreadCount, 1);
  let injected = false;
  const racingDB = {
    prepare(sql) { return db.prepare(sql); },
    async batch(statements) {
      if (!injected) { injected = true; await insertEvents(context.admin.tenantId, 1); }
      return db.batch(statements);
    },
  };
  assert.equal((await markNotificationsRead(racingDB, context.admin, { through: Number.MAX_SAFE_INTEGER })).unreadCount, 1);
  const unread = await listNotifications(db, context.admin, query({ filter: 'unread' }));
  assert.equal(unread.items.length, 1);
  assert.equal(unread.items[0].id, unread.latestId);
});

test('list and read validate cursors, body types, limits and credential-bearing extra fields', async () => {
  const context = await setup('notify-validation');
  for (const value of ['-1', '1.5', '0', '1e2', 'Infinity', '9007199254740992', '']) {
    await assert.rejects(listNotifications(db, context.admin, query({ before: value })), { status: 400 });
  }
  await assert.rejects(listNotifications(db, context.admin, query({ filter: 'other' })), { status: 400 });
  await assert.rejects(listNotifications(db, context.admin, query({ includeDemo: 'yes' })), { status: 400 });
  for (const body of [null, [], {}, { ids: [] }, { ids: ['1'] }, { ids: [1.2] }, { ids: Array(101).fill(1) },
    { ids: [1], through: 1 }, { through: -1 }, { through: 1, includeDemo: '1' }, { through: 1, tenantId: 'forged' }]) {
    await assert.rejects(markNotificationsRead(db, context.admin, body), { status: 400 });
  }
  assert.deepEqual(await markNotificationsRead(db, context.admin, { through: 0 }), { unreadCount: 0 });
});

test('low inventory sends one event per threshold entry, retaining the resolved historical notification', async () => {
  const context = await setup('notify-stock'); const pid = context.product.id;
  for (const stock of [5, 4, 4]) await executeCommand(db, context.admin, cmd('setWarehouseStock', [pid, stock]));
  assert.equal(await count(context.admin.tenantId), 1);
  assert.deepEqual((await listNotifications(db, context.admin)).items[0].currentStatus, { label: '待补货', resolved: false });
  await executeCommand(db, context.admin, cmd('setWarehouseStock', [pid, 8]));
  assert.deepEqual((await listNotifications(db, context.admin)).items[0].currentStatus, { label: '库存已恢复', resolved: true });
  await executeCommand(db, context.admin, cmd('setWarehouseStock', [pid, 2]));
  assert.equal(await count(context.admin.tenantId), 2);
  assert.equal((await listNotifications(db, context.admin)).unreadCount, 2);
});

test('shortages are persisted once, can be resolved without packing, and private line notes stay hidden from stores', async () => {
  const context = await setup('notify-shortage'), other = await setup('notify-shortage-other');
  const { result: order } = await submit(context); const pid = context.product.id;
  await executeCommand(db, context.admin, cmd('setPackingNote', [order.id, pid, '保留外包装', 'other']));
  assert.equal(await count(context.admin.tenantId), 1);
  const note = cmd('setPackingNote', [order.id, pid, '少 1 箱，等待补货', 'shortage']);
  await executeCommand(db, context.admin, note); await executeCommand(db, context.admin, note);
  await executeCommand(db, context.admin, cmd('setPackingNote', note.args));
  assert.equal(await count(context.admin.tenantId), 2);
  const shortage = (await listNotifications(db, context.admin)).items.find(event => event.kind === 'packing_shortage');
  assert.deepEqual(shortage.currentStatus, { label: '缺货待处理', resolved: false });
  assert.ok(shortage.body.includes('少 1 箱'));
  await assert.rejects(executeCommand(db, context.store, cmd('resolvePackingIssue', [order.id, pid])), { status: 403 });
  await assert.rejects(executeCommand(db, other.admin, cmd('resolvePackingIssue', [order.id, pid])), { status: 404 });
  await assert.rejects(executeCommand(db, context.admin, cmd('setPackingNote', [order.id, pid, '备注', 'invalid'])), { status: 400 });
  await executeCommand(db, context.admin, cmd('resolvePackingIssue', [order.id, pid]));
  const saved = (await getState(db, context.admin)).state.orders[0];
  assert.equal(saved.items[0].packedQty, 0); assert.equal(saved.items[0].packingIssue.status, 'resolved');
  assert.equal(saved.items[0].packingNote, note.args[2]);
  const storeLine = (await getState(db, context.store)).state.orders[0].items[0];
  assert.equal(storeLine.packingNote, undefined); assert.equal(storeLine.packingIssue, undefined);
  assert.deepEqual((await listNotifications(db, context.admin)).items.find(event => event.kind === 'packing_shortage').currentStatus, { label: '缺货已处理', resolved: true });
});

test('order exception resolutions preserve the original note and cannot be done by store users', async () => {
  const context = await setup('notify-order-issue'); const { result: order } = await submit(context);
  await executeCommand(db, context.store, cmd('recordIssue', [order.id, '请检查外包装']));
  await executeCommand(db, context.store, cmd('recordIssue', [order.id, '请检查外包装']));
  assert.equal(await count(context.admin.tenantId), 2);
  await assert.rejects(executeCommand(db, context.store, cmd('resolveOrderIssue', [order.id])), { status: 403 });
  const result = await executeCommand(db, context.admin, cmd('resolveOrderIssue', [order.id]));
  assert.equal(result.result.issue, '请检查外包装'); assert.ok(result.result.issueResolvedAt);
  assert.equal(result.result.items[0].packedQty, 0);
  assert.ok((await getState(db, context.store)).state.orders[0].issueResolvedAt);
  await executeCommand(db, context.admin, cmd('resolveOrderIssue', [order.id]));
  assert.equal(await count(context.admin.tenantId), 2);
  await executeCommand(db, context.store, cmd('recordIssue', [order.id, '请检查外包装']));
  assert.equal(await count(context.admin.tenantId), 3);
});

test('checking resolves shortage history; undo reopens automatically resolved exceptions and later delivery updates current status', async () => {
  const context = await setup('notify-packing'); const { result: order } = await submit(context); const pid = context.product.id;
  await executeCommand(db, context.admin, cmd('setPackingNote', [order.id, pid, '缺货', 'shortage']));
  await executeCommand(db, context.admin, cmd('setPackLineDone', [order.id, pid, true]));
  const complete = (await getState(db, context.admin)).state.orders[0];
  assert.equal(complete.items[0].packingIssue.status, 'resolved'); assert.equal(complete.items[0].packingNote, '缺货');
  await executeCommand(db, context.admin, cmd('setPackLineDone', [order.id, pid, false]));
  assert.equal((await getState(db, context.admin)).state.orders[0].items[0].packingIssue.status, 'open');
  await executeCommand(db, context.admin, cmd('setPackLineDone', [order.id, pid, true]));
  for (const stage of ['ready', 'delivering', 'delivered']) await executeCommand(db, context.admin, cmd('setStage', [order.id, stage]));
  const page = await listNotifications(db, context.admin);
  assert.equal(page.items[0].kind, 'order_delivered');
  assert.equal(page.items.filter(item => item.kind === 'packing_shortage').every(item => item.currentStatus.resolved), true);
  assert.deepEqual(page.items.find(item => item.kind === 'order_submitted').currentStatus, { label: '已送达', resolved: true });
  await assert.rejects(executeCommand(db, context.admin, cmd('resolvePackingIssue', [order.id, pid])), /已送达/);
  await assert.rejects(executeCommand(db, context.admin, cmd('resolveOrderIssue', [order.id])), /已送达/);
});

async function session(principal, name) {
  const token = createHash('sha256').update(name).digest('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  if (principal.tenantId) await db.prepare("INSERT OR IGNORE INTO organizations(tenant_id,code,created_at) VALUES(?,?,?)")
    .bind(principal.tenantId, 'ORG-' + principal.tenantId, timestamp).run();
  await db.prepare(`INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,created_at)
    VALUES(?,?,?,?,?,'member',?,'','active',?)`).bind(principal.userId, name, principal.tenantId || null, principal.storeId || null, principal.role, principal.displayName || name, timestamp).run();
  await db.prepare('INSERT INTO account_sessions(hash,account_id,expires,version) VALUES(?,?,?,0)')
    .bind(createHash('sha256').update(token).digest('hex'), principal.userId, timestamp + 600).run();
  return token;
}
async function api(token, path, { body, method, headers = {} } = {}) {
  return worker.fetch(new Request(origin + path, { method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { Origin: origin, Cookie: '__Host-kuraflow_account=' + token, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  }), { DB: db, PUBLIC_ORIGIN: origin, LOCAL_TEST: '0' }, {});
}

test('HTTP routes enforce active per-account identities, role, origin, body size and JSON', async () => {
  const context = await setup('notify-http'); await submit(context);
  const adminToken = await session(context.admin, 'notify-http-admin');
  const memberToken = await session(context.otherAdmin, 'notify-http-member');
  const storeToken = await session(context.store, 'notify-http-store');
  const platformToken = await session({ userId: 'notify-http-platform', role: 'platform' }, 'notify-http-platform');
  const listed = await api(adminToken, '/api/notifications'); assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('Cache-Control'), 'no-store');
  const event = (await listed.json()).items[0];
  assert.equal((await api('', '/api/notifications')).status, 401);
  for (const token of [storeToken, platformToken]) {
    assert.equal((await api(token, '/api/notifications')).status, 403);
    assert.equal((await api(token, '/api/notifications/read', { body: { ids: [event.id] } })).status, 403);
  }
  assert.equal((await api(adminToken, '/api/notifications/read', { body: { ids: [event.id] }, headers: { Origin: 'https://attacker.test' } })).status, 403);
  assert.equal((await api(adminToken, '/api/notifications/read', { body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await api(adminToken, '/api/notifications/read', { body: '{' })).status, 400);
  assert.equal((await api(adminToken, '/api/notifications/read', { body: ' '.repeat(9000) })).status, 413);
  assert.equal((await api(adminToken, '/api/notifications/read', { body: { through: event.id } })).status, 200);
  assert.equal((await (await api(memberToken, '/api/notifications')).json()).unreadCount, 1);
  await db.prepare("UPDATE staff_accounts SET status = 'disabled' WHERE id = ?").bind(context.admin.userId).run();
  assert.equal((await api(adminToken, '/api/notifications')).status, 401);
  assert.equal((await api(adminToken, '/api/notifications/read', { body: { through: event.id } })).status, 401);
  await db.prepare('UPDATE organizations SET active = 0 WHERE tenant_id = ?').bind(context.admin.tenantId).run();
  assert.equal((await api(memberToken, '/api/notifications')).status, 401);
});
