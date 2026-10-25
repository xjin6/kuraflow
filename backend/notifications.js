import { notificationCurrentStatus } from '../src/shared/notification-domain.js';
import { getPortalFeaturePolicy } from './portal-features.js';
import { listPlatformNotifications, markPlatformNotificationsRead } from './portal-notifications.js';

const PAGE_SIZE = 50;
const fail = (message, status = 400, code = 'INVALID_NOTIFICATION') => {
  throw Object.assign(new Error(message), { status, code });
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const latestDB = db => db.withSession ? db.withSession('first-primary') : db;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);

function assertPrincipal(principal) {
  if (!principal) fail('请先登录。', 401, 'UNAUTHORIZED');
  if (!['admin', 'store', 'platform'].includes(principal.role) || !identifier(principal.userId)) fail('账号范围不正确。', 403, 'FORBIDDEN');
  if (principal.role === 'platform') {
    if (principal.tenantId || principal.storeId) fail('账号范围不正确。', 403, 'FORBIDDEN');
  } else if (!identifier(principal.tenantId) || (principal.role === 'store' ? !identifier(principal.storeId) : Boolean(principal.storeId))) {
    fail('账号范围不正确。', 403, 'FORBIDDEN');
  }
}

async function notificationPolicy(db, principal) {
  const policy = await getPortalFeaturePolicy(db, principal);
  if (!policy.notificationsEnabled) fail('通知功能尚未开启。', 403, 'NOTIFICATIONS_DISABLED');
}

// Store notifications expose public order milestones only. Never reuse the
// saved management title/body: they can contain internal packing notes.
const storeKinds = ['order_submitted', 'order_ready', 'order_delivering', 'order_delivered', 'store_reminder'];
function eventScope(principal, includeDemo) {
  return {
    sql: `e.tenant_id = ? ${includeDemo ? '' : 'AND e.is_demo = 0'}${principal.role === 'store'
      ? ` AND e.target_type = 'order' AND e.kind IN (${storeKinds.map(() => '?').join(',')})
        AND EXISTS (SELECT 1 FROM orders scoped_order WHERE scoped_order.tenant_id = e.tenant_id
          AND scoped_order.id = e.target_id AND scoped_order.store_id = ?
          AND (e.order_id IS NULL OR e.order_id = scoped_order.id))` : ''}`,
    params: [principal.tenantId, ...(principal.role === 'store' ? [...storeKinds, principal.storeId] : [])],
  };
}

function positiveId(value, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail('通知编号不正确。');
  return value;
}

function parseQuery(params) {
  const query = params instanceof URLSearchParams ? params : new URLSearchParams(params);
  const filter = query.get('filter') || 'all';
  if (!['all', 'unread'].includes(filter)) fail('通知筛选条件不正确。');
  const includeDemo = query.get('includeDemo') || '0';
  if (!['0', '1'].includes(includeDemo)) fail('演示通知筛选条件不正确。');
  let before;
  if (query.has('before')) {
    const text = query.get('before');
    if (!/^[1-9]\d*$/.test(text)) fail('通知分页编号不正确。');
    before = positiveId(Number(text));
  }
  return { filter, includeDemo: includeDemo === '1', before };
}

function countStatement(db, principal, includeDemo) {
  const scope = eventScope(principal, includeDemo);
  return db.prepare(`SELECT count(*) AS unread_count
    FROM notification_events e WHERE ${scope.sql}
    AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.tenant_id = e.tenant_id AND r.event_id = e.id AND r.user_id = ?)`)
    .bind(...scope.params, principal.userId);
}

function eventFromRow(row) {
  return {
    id: row.id, kind: row.kind, title: row.title, body: row.body,
    targetType: row.target_type, targetId: row.target_id,
    ...(row.order_id ? { orderId: row.order_id } : {}),
    ...(row.product_id ? { productId: row.product_id } : {}),
    isDemo: row.is_demo === 1, createdAt: row.created_at,
    actorName: row.actor_name, read: row.is_read === 1,
  };
}

/** Reads are scoped to a verified principal; tenant/user request parameters are ignored. */
export async function listNotifications(database, principal, params = new URLSearchParams()) {
  assertPrincipal(principal);
  const { filter, includeDemo, before } = parseQuery(params);
  const db = latestDB(database);
  await notificationPolicy(db, principal);
  if (principal.role === 'platform') return listPlatformNotifications(db, principal, { filter, before });
  const scope = eventScope(principal, includeDemo);
  const [pageResult, countResult, latestResult, tenantResult] = await db.batch([
    db.prepare(`SELECT e.*, r.event_id IS NOT NULL AS is_read FROM notification_events e
      LEFT JOIN notification_reads r ON r.tenant_id = e.tenant_id AND r.event_id = e.id AND r.user_id = ?
      WHERE ${scope.sql}
      ${filter === 'unread' ? 'AND r.event_id IS NULL' : ''} ${before ? 'AND e.id < ?' : ''}
      ORDER BY e.id DESC LIMIT ?`)
      .bind(principal.userId, ...scope.params, ...(before ? [before] : []), PAGE_SIZE + 1),
    countStatement(db, principal, includeDemo),
    db.prepare(`SELECT coalesce(max(e.id), 0) AS latest_id FROM notification_events e WHERE ${scope.sql}`)
      .bind(...scope.params),
    db.prepare("SELECT json_extract(core_json, '$.inventory') AS inventory_json FROM tenants WHERE id = ?")
      .bind(principal.tenantId),
  ]);
  if (!tenantResult.results.length) fail('公司资料尚未初始化。', 404, 'TENANT_NOT_FOUND');
  const rows = pageResult.results.slice(0, PAGE_SIZE);
  const orderIds = [...new Set(rows.map(row => row.order_id || (row.target_type === 'order' ? row.target_id : null)).filter(Boolean))];
  const productIds = [...new Set(rows.map(row => row.product_id || (row.target_type === 'product' ? row.target_id : null)).filter(Boolean))];
  const [orders, products] = await db.batch([
    db.prepare(`SELECT data_json FROM orders WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?)) ${principal.role === 'store' ? 'AND store_id = ?' : ''}`)
      .bind(principal.tenantId, JSON.stringify(orderIds), ...(principal.role === 'store' ? [principal.storeId] : [])),
    db.prepare('SELECT data_json FROM products WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))').bind(principal.tenantId, JSON.stringify(productIds)),
  ]);
  const current = {
    orders: orders.results.map(row => JSON.parse(row.data_json)),
    products: products.results.map(row => JSON.parse(row.data_json)),
    inventory: JSON.parse(tenantResult.results[0].inventory_json || '{}'),
  };
  const items = rows.map(row => {
    const event = eventFromRow(row);
    if (principal.role === 'store') {
      const order = current.orders.find(item => item.id === event.targetId);
      if (!order) return null;
      const titleKey = {
        order_submitted: '订单已提交', order_ready: '订单已完成配货', order_delivering: '订单已开始配送',
        order_delivered: '订单已送达', store_reminder: '催单已提交',
      }[event.kind];
      return {
        id: event.id, kind: event.kind, title: titleKey, titleKey,
        body: '', bodyKey: '订单 {0} · 配送日期 {1}', bodyParams: [event.targetId, order?.deliveryDate || order?.date || '—'],
        targetType: 'order', targetId: event.targetId, orderId: event.targetId,
        isDemo: event.isDemo, createdAt: event.createdAt, read: event.read,
        currentStatus: notificationCurrentStatus(event, { orders: [{ id: order.id, stage: order.stage }] }),
      };
    }
    return { ...event, currentStatus: notificationCurrentStatus(event, current) };
  }).filter(Boolean);
  const hasMore = pageResult.results.length > PAGE_SIZE;
  return {
    items, unreadCount: countResult.results[0].unread_count,
    latestId: latestResult.results[0].latest_id,
    hasMore, nextCursor: hasMore ? rows.at(-1).id : null,
  };
}

/** Personal read markers never mutate a business order, issue or revision. */
export async function markNotificationsRead(database, principal, body) {
  assertPrincipal(principal);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) fail('通知操作格式不正确。');
  if (Object.keys(body).some(key => !['ids', 'through', 'includeDemo'].includes(key))) fail('通知操作字段不正确。');
  if (own(body, 'ids') === own(body, 'through')) fail('请选择要标记的通知。');
  if (body.includeDemo != null && typeof body.includeDemo !== 'boolean') fail('演示通知筛选条件不正确。');
  const includeDemo = body.includeDemo === true;
  const db = latestDB(database);
  await notificationPolicy(db, principal);
  if (own(body, 'ids')) {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100) fail('每次可标记 1 至 100 条通知。');
    body = { ...body, ids: [...new Set(body.ids.map(id => positiveId(id)))] };
  } else positiveId(body.through, true);
  if (principal.role === 'platform') return markPlatformNotificationsRead(db, principal, body);
  const scope = eventScope(principal, includeDemo);
  const timestamp = new Date().toISOString();
  let statement;
  if (own(body, 'ids')) {
    const ids = body.ids;
    const encoded = JSON.stringify(ids);
    const found = await db.prepare(`SELECT e.id FROM notification_events e WHERE ${scope.sql} AND e.id IN (SELECT value FROM json_each(?))`)
      .bind(...scope.params, encoded).all();
    if (found.results.length !== ids.length) fail('通知不存在。', 404, 'NOTIFICATION_NOT_FOUND');
    statement = db.prepare(`INSERT OR IGNORE INTO notification_reads (tenant_id, user_id, event_id, read_at)
      SELECT e.tenant_id, ?, e.id, ? FROM notification_events e WHERE ${scope.sql} AND e.id IN (SELECT value FROM json_each(?))`)
      .bind(principal.userId, timestamp, ...scope.params, encoded);
  } else {
    const through = positiveId(body.through, true);
    // Capture the highest owned ID before writing. A forged future ID cannot
    // mark an event that arrives after this request's initial snapshot as read.
    const observed = await db.prepare(`SELECT coalesce(max(e.id), 0) AS latest_id FROM notification_events e WHERE ${scope.sql}`)
      .bind(...scope.params).first();
    const boundary = Math.min(through, observed.latest_id);
    statement = db.prepare(`INSERT OR IGNORE INTO notification_reads (tenant_id, user_id, event_id, read_at)
      SELECT e.tenant_id, ?, e.id, ? FROM notification_events e WHERE ${scope.sql} AND e.id <= ?`)
      .bind(principal.userId, timestamp, ...scope.params, boundary);
  }
  const [, result] = await db.batch([statement, countStatement(db, principal, includeDemo)]);
  return { unreadCount: result.results[0].unread_count };
}

/** Appended to the same transaction as the business command and idempotency key. */
export function notificationStatements(db, tenantId, events) {
  if (!events.length) return [];
  return [db.prepare(`INSERT INTO notification_events
    (tenant_id, event_key, kind, title, body, target_type, target_id, order_id, product_id, is_demo, created_at, actor_name)
    SELECT ?, json_extract(value, '$.eventKey'), json_extract(value, '$.kind'), json_extract(value, '$.title'),
      json_extract(value, '$.body'), json_extract(value, '$.targetType'), json_extract(value, '$.targetId'),
      json_extract(value, '$.orderId'), json_extract(value, '$.productId'),
      CASE WHEN json_extract(value, '$.isDemo') THEN 1 ELSE 0 END, json_extract(value, '$.createdAt'),
      coalesce(json_extract(value, '$.actorName'), '')
    FROM json_each(?) WHERE 1 ON CONFLICT(tenant_id, event_key) DO NOTHING`).bind(tenantId, JSON.stringify(events))];
}
