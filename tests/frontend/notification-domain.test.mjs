import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KitchenModel } from '../../src/shared/data.js';
import { businessTasks } from '../../src/shared/overview-data.js';
import { isPackingShortage, orderHasOpenIssue, deriveNotificationEvents, notificationCurrentStatus } from '../../src/shared/notification-domain.js';
import { createLocalNotifications, LOCAL_NOTIFICATIONS_KEY } from '../../src/features/notifications/local-notifications.js';

const date = '2026-10-20', at = '2026-10-20T01:00:00.000Z';
const line = (extra = {}) => ({ productId: 'p1', qty: 2, packedQty: 0, unit: '袋', ...extra });
const order = (extra = {}) => ({ id: 'o1', storeId: 's1', stage: 'pending', deliveryDate: date, items: [line()], ...extra });
const state = (extra = {}) => ({ stores: [{ id: 's1', name: '测试门店', accessCode: 'private-store-code' }], products: [{ id: 'p1', name: '测试商品', unit: '袋', stock: 10, basePrice: 999 }], inventory: { p1: 10 }, orders: [order()], reminders: [], ...extra });
const metadata = { eventKey: 'command-1', actorId: 'actor-a', actorName: '甲', now: at };
function modelFor(saved = state()) {
  const model = Object.create(KitchenModel.prototype); model.state = saved; model.storage = null;
  return model;
}
function memoryStorage() {
  const saved = new Map(); return { getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), saved };
}

test('shortage detection distinguishes explicit statuses, legacy shortages and ordinary notes', () => {
  for (const note of ['缺货，等待补货', '欠品', '数量不足', '缺少一袋', '短缺', '少 2 袋']) assert.equal(isPackingShortage(line({ packingNote: note })), true, note);
  for (const note of ['轻放', '后门收货', '不缺货', '没有缺货', '少量分装']) assert.equal(isPackingShortage(line({ packingNote: note })), false, note);
  assert.equal(isPackingShortage(line({ packedQty: 2, packingNote: '缺货' })), false);
  assert.equal(isPackingShortage(line({ packedQty: 2, packingConfirmed: false, packingNote: '缺货' })), true);
  assert.equal(isPackingShortage(line({ packingIssue: { type: 'other', status: 'open' }, packingNote: '缺货' })), false);
  assert.equal(isPackingShortage(line({ packingIssue: { type: 'shortage', status: 'resolved' }, packingNote: '缺货' })), false);
  assert.equal(orderHasOpenIssue(order({ items: [line({ packingNote: '缺货' })] })), true);
  assert.equal(orderHasOpenIssue(order({ stage: 'delivered', issue: '原异常' })), false);
});

test('notification derivation does not backfill historical records or emit packing tick noise', () => {
  const before = state(), after = structuredClone(before);
  assert.deepEqual(deriveNotificationEvents(null, after, metadata), []);
  assert.deepEqual(deriveNotificationEvents(before, after, metadata), []);
  after.orders[0].stage = 'packing'; after.orders[0].items[0].packedQty = 2;
  assert.deepEqual(deriveNotificationEvents(before, after, metadata), []);
  after.orders[0].stage = 'ready'; after.orders[0].readyAt = at;
  const [event] = deriveNotificationEvents(before, after, metadata);
  assert.equal(event.kind, 'order_ready'); assert.equal(event.createdAt, at);
  assert.equal(event.eventKey, 'command-1:order_ready:o1');
});

test('new order and reminder events use saved timestamps and exclude account/price metadata', () => {
  const before = state({ orders: [] }), after = state();
  after.orders[0].submittedAt = '2026-10-19T22:00:00.000Z';
  const events = deriveNotificationEvents(before, after, metadata);
  assert.equal(events.length, 1); assert.equal(events[0].kind, 'order_submitted');
  assert.equal(events[0].createdAt, after.orders[0].submittedAt);
  assert.doesNotMatch(JSON.stringify(events), /private-store-code|999|basePrice|accessCode/);
  const reminded = structuredClone(after); reminded.reminders = [{ id: 'r1', orderId: 'o1', createdAt: at }, { id: 'r2', orderId: 'o1', createdAt: at }];
  const reminders = deriveNotificationEvents(after, reminded, metadata);
  assert.equal(reminders.length, 2); assert.notEqual(reminders[0].eventKey, reminders[1].eventKey);
  assert.equal(reminders[0].kind, 'store_reminder');
});

test('low-stock events only notify entry into a known low level and reset after recovery', () => {
  for (const old of [null, 6, 10]) {
    const before = state({ inventory: { p1: old } }), after = state({ inventory: { p1: 5 } });
    assert.equal(deriveNotificationEvents(before, after, metadata)[0].kind, 'stock_low');
  }
  assert.deepEqual(deriveNotificationEvents(state({ inventory: { p1: 5 } }), state({ inventory: { p1: 4 } }), metadata), []);
  assert.deepEqual(deriveNotificationEvents(state({ inventory: { p1: 4 } }), state({ inventory: { p1: 8 } }), metadata), []);
  assert.equal(deriveNotificationEvents(state({ inventory: { p1: 8 } }), state({ inventory: { p1: 4 } }), metadata).length, 1);
  assert.deepEqual(deriveNotificationEvents(state(), state({ inventory: { p1: null } }), metadata), []);
});

test('shortage and order exception events are idempotent and notify changed or reopened issues', () => {
  const before = state(), after = structuredClone(before);
  after.orders[0].items[0].packingNote = '缺货一袋';
  const events = deriveNotificationEvents(before, after, metadata);
  assert.equal(events[0].kind, 'packing_shortage'); assert.equal(events[0].productId, 'p1');
  assert.equal(events[0].body, '测试商品：缺货一袋');
  assert.deepEqual(deriveNotificationEvents(after, structuredClone(after), metadata), []);
  const changed = structuredClone(after); changed.orders[0].items[0].packingNote = '缺货两袋';
  assert.equal(deriveNotificationEvents(after, changed, metadata).length, 1);
  const reported = state(); reported.orders[0].issue = '送货地址有误'; reported.orders[0].issueReportedAt = at;
  assert.equal(deriveNotificationEvents(before, reported, metadata)[0].kind, 'order_issue');
  const resolved = structuredClone(reported); resolved.orders[0].issueResolvedAt = at;
  assert.deepEqual(deriveNotificationEvents(reported, resolved, metadata), []);
  assert.equal(deriveNotificationEvents(resolved, reported, metadata)[0].kind, 'order_issue');
});

test('current notification status follows business data without changing it', () => {
  const saved = state(), snapshot = structuredClone(saved);
  assert.deepEqual(notificationCurrentStatus({ kind: 'order_submitted', targetType: 'order', targetId: 'o1' }, saved), { label: '待配货', resolved: false });
  assert.deepEqual(notificationCurrentStatus({ kind: 'stock_low', targetType: 'product', targetId: 'p1' }, saved), { label: '库存已恢复', resolved: true });
  assert.deepEqual(notificationCurrentStatus({ targetType: 'order', targetId: 'missing' }, saved), { label: '已归档', resolved: true });
  assert.deepEqual(saved, snapshot);
});

test('checking shortage resolves history and undo reopens only automatic resolutions', () => {
  const model = modelFor(), item = model.state.orders[0].items[0];
  model.setPackingNote('o1', 'p1', '等待到货', 'shortage');
  assert.equal(isPackingShortage(item), true);
  const first = structuredClone(item.packingIssue); model.setPackingNote('o1', 'p1', '等待到货', 'shortage');
  assert.deepEqual(item.packingIssue, first);
  model.setPackLineDone('o1', 'p1', true);
  assert.equal(item.packingIssue.resolution, 'packed'); assert.equal(isPackingShortage(item), false);
  assert.equal(item.packingNote, '等待到货');
  model.setPackLineDone('o1', 'p1', false); assert.equal(isPackingShortage(item), true);
  const quantity = item.packedQty;
  model.resolvePackingIssue('o1', 'p1'); assert.equal(item.packedQty, quantity);
  model.setPackLineDone('o1', 'p1', true); model.setPackLineDone('o1', 'p1', false);
  assert.equal(item.packingIssue.resolution, 'manual'); assert.equal(isPackingShortage(item), false);
  model.setPackingNote('o1', 'p1', '等待到货', 'shortage'); assert.equal(isPackingShortage(item), false);
});

test('legacy confirmation, numeric editing and all-line confirmation retain order exception history', () => {
  const model = modelFor(), current = model.state.orders[0], item = current.items[0];
  model.recordIssue('o1', '缺货待补');
  const reportedAt = current.issueReportedAt; model.recordIssue('o1', '缺货待补'); assert.equal(current.issueReportedAt, reportedAt);
  item.packingNote = '缺货';
  model.packLine('o1', 'p1', 2);
  assert.equal(current.issue, '缺货待补'); assert.equal(current.issueResolvedAt, undefined);
  model.confirmPackLine('o1', 'p1');
  assert.equal(current.issueResolution, 'packed'); assert.equal(item.packingIssue.resolution, 'packed');
  model.packLine('o1', 'p1', 1); assert.equal(current.issueResolvedAt, undefined); assert.equal(isPackingShortage(item), true);
  model.resolveOrderIssue('o1'); const resolved = current.issueResolvedAt;
  model.setPackLineDone('o1', 'p1', true); model.setPackLineDone('o1', 'p1', false);
  assert.equal(current.issueResolvedAt, resolved); assert.equal(current.issueResolution, 'manual');
});

test('new shortages after a completed check require another confirmation; clearing is explicit', () => {
  const model = modelFor(), item = model.state.orders[0].items[0];
  model.setPackLineDone('o1', 'p1', true); model.setPackingNote('o1', 'p1', '发现缺货', 'shortage');
  assert.equal(item.packingConfirmed, false); assert.equal(item.packedQty, 2);
  assert.throws(() => model.setStage('o1', 'ready'), /未配齐/);
  model.setPackingNote('o1', 'p1', ''); assert.equal(item.packingNote, undefined); assert.equal(isPackingShortage(item), false);
  model.setPackLineDone('o1', 'p1', true); model.setStage('o1', 'ready'); model.setStage('o1', 'delivering'); model.setStage('o1', 'delivered');
  for (const action of [() => model.resolvePackingIssue('o1', 'p1'), () => model.recordIssue('o1', '异常'), () => model.resolveOrderIssue('o1')]) assert.throws(action, /不能修改/);
});

test('business tasks prioritize and deduplicate shortages, ignore ordinary delivery and future packing', () => {
  const saved = state({ orders: [order({ deliveryDate: '2026-10-19', items: [line({ packingNote: '缺货一袋' })] }), order({ id: 'normal', stage: 'delivering' }), order({ id: 'future', deliveryDate: '2026-10-21' }), order({ id: 'overdue', deliveryDate: '2026-10-19', stage: 'delivering' }), order({ id: 'ready', stage: 'ready' }), order({ id: 'demo', isDemo: true })] });
  const model = modelFor(saved), result = businessTasks(model, date);
  assert.deepEqual(result.tasks.map(row => [row.orderId, row.kind]), [['o1', 'issue'], ['overdue', 'overdue'], ['ready', 'ready']]);
  assert.match(result.tasks[0].description, /测试商品：缺货一袋/);
  assert.equal(result.delivering.length, 1);
  model.resolvePackingIssue('o1', 'p1');
  assert.equal(businessTasks(model, date).tasks.find(row => row.orderId === 'o1').kind, 'overdue');
  assert.ok(businessTasks(model, date, { includeDemo: true }).tasks.some(row => row.orderId === 'demo'));
});

test('local journal begins empty and persists transitions with personal read state', () => {
  const storage = memoryStorage(), model = modelFor(), alice = createLocalNotifications({ model, storage, actorId: 'alice' });
  const bob = createLocalNotifications({ model, storage, actorId: 'bob' });
  assert.equal(alice.list().items.length, 0);
  model.recordIssue('o1', '缺货待补');
  assert.equal(alice.list().items.length, 1); assert.equal(bob.list().unreadCount, 1);
  const snapshot = structuredClone(model.state), id = alice.list().items[0].id;
  alice.markRead({ ids: [id] });
  assert.equal(alice.list().unreadCount, 0); assert.equal(bob.list().unreadCount, 1);
  assert.deepEqual(model.state, snapshot);
  assert.doesNotMatch(storage.getItem(LOCAL_NOTIFICATIONS_KEY), /private-store-code|basePrice/);
  alice.dispose(); bob.dispose();
  const restored = createLocalNotifications({ model, storage, actorId: 'alice' });
  assert.equal(restored.list().items.length, 1); assert.equal(restored.list().unreadCount, 0); restored.dispose();
});

test('local mark-all applies only through its snapshot and demo scope', () => {
  const model = modelFor(), storage = memoryStorage(), journal = createLocalNotifications({ model, storage });
  model.recordIssue('o1', '第一条异常'); const first = journal.list().latestId;
  model.recordIssue('o1', '第二条异常');
  model.state.orders.push(order({ id: 'demo', isDemo: true, submittedAt: at })); model.save();
  assert.equal(journal.list().unreadCount, 2); assert.equal(journal.list({ includeDemo: true }).unreadCount, 3);
  journal.markRead({ through: first, includeDemo: false });
  assert.equal(journal.list().unreadCount, 1); assert.equal(journal.list({ includeDemo: true }).unreadCount, 2);
  journal.markRead({ through: 1000, includeDemo: false });
  assert.equal(journal.list().unreadCount, 0); assert.equal(journal.list({ includeDemo: true }).unreadCount, 1);
  model.recordIssue('o1', '第三条异常'); assert.equal(journal.list().unreadCount, 1);
  assert.throws(() => journal.markRead({ ids: [999] }), /不存在/); journal.dispose();
});

test('local stock recovery and later shortage produce only distinct entry events', () => {
  const model = modelFor(), storage = memoryStorage(), journal = createLocalNotifications({ model, storage });
  for (const qty of [5, 4, 4, 8, 5]) { model.state.inventory.p1 = qty; model.save(); }
  assert.equal(journal.list().items.length, 2); assert.equal(new Set(journal.list().items.map(row => row.id)).size, 2);
  journal.dispose();
});

test('local refresh establishes external-state baseline without retrospective notifications', () => {
  const model = modelFor(), storage = memoryStorage(), journal = createLocalNotifications({ model, storage });
  model.state = state({ orders: [order({ issue: '其他窗口已记录的异常' })] }); journal.refresh(); model.save();
  assert.equal(journal.list().items.length, 0);
  model.recordIssue('o1', '本次修改'); assert.equal(journal.list().items.length, 1); journal.dispose();
});

test('local persistence failures keep unread records and disclose the failure', () => {
  const model = modelFor(), storage = { getItem: () => null, setItem: () => { throw new Error('quota'); } };
  const journal = createLocalNotifications({ model, storage });
  model.recordIssue('o1', '第一条异常'); model.recordIssue('o1', '第二条异常');
  const result = journal.list(); assert.equal(result.unreadCount, 2); assert.match(result.persistenceWarning, /无法保存/);
  journal.dispose();
});
