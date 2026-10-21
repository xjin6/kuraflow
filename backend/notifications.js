import { notificationCurrentStatus } from '../notification-domain.js';

const PAGE_SIZE = 50;
const fail = (message, status = 400, code = 'INVALID_NOTIFICATION') => {
  throw Object.assign(new Error(message), { status, code });
};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const latestDB = db => db.withSession ? db.withSession('first-primary') : db;
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
  && !['__proto__', 'constructor', 'prototype'].includes(value);

function assertAdmin(principal) {
  if (!principal) fail('请先登录。', 401, 'UNAUTHORIZED');
  if (principal.role !== 'admin') fail('只有管理端可以查看通知。', 403, 'FORBIDDEN');
  if (!identifier(principal.tenantId) || !identifier(principal.userId)) fail('账号范围不正确。', 403, 'FORBIDDEN');
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
  return db.prepare(`SELECT count(*) AS unread_count
    FROM notification_events e WHERE e.tenant_id = ? ${includeDemo ? '' : 'AND e.is_demo = 0'}
    AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.tenant_id = e.tenant_id AND r.event_id = e.id AND r.user_id = ?)`)
    .bind(principal.tenantId, principal.userId);
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
  assertAdmin(principal);
  const { filter, includeDemo, before } = parseQuery(params);
  const db = latestDB(database);
  const [pageResult, countResult, latestResult, tenantResult] = await db.batch([
    db.prepare(`SELECT e.*, r.event_id IS NOT NULL AS is_read FROM notification_events e
      LEFT JOIN notification_reads r ON r.tenant_id = e.tenant_id AND r.event_id = e.id AND r.user_id = ?
      WHERE e.tenant_id = ? ${includeDemo ? '' : 'AND e.is_demo = 0'}
      ${filter === 'unread' ? 'AND r.event_id IS NULL' : ''} ${before ? 'AND e.id < ?' : ''}
      ORDER BY e.id DESC LIMIT ?`)
      .bind(principal.userId, principal.tenantId, ...(before ? [before] : []), PAGE_SIZE + 1),
    countStatement(db, principal, includeDemo),
    db.prepare(`SELECT coalesce(max(id), 0) AS latest_id FROM notification_events WHERE tenant_id = ? ${includeDemo ? '' : 'AND is_demo = 0'}`)
      .bind(principal.tenantId),
    db.prepare("SELECT json_extract(core_json, '$.inventory') AS inventory_json FROM tenants WHERE id = ?")
      .bind(principal.tenantId),
  ]);
  if (!tenantResult.results.length) fail('公司资料尚未初始化。', 404, 'TENANT_NOT_FOUND');
  const rows = pageResult.results.slice(0, PAGE_SIZE);
  const orderIds = [...new Set(rows.map(row => row.order_id || (row.target_type === 'order' ? row.target_id : null)).filter(Boolean))];
  const productIds = [...new Set(rows.map(row => row.product_id || (row.target_type === 'product' ? row.target_id : null)).filter(Boolean))];
  const [orders, products] = await db.batch([
    db.prepare('SELECT data_json FROM orders WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))').bind(principal.tenantId, JSON.stringify(orderIds)),
    db.prepare('SELECT data_json FROM products WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))').bind(principal.tenantId, JSON.stringify(productIds)),
  ]);
  const current = {
    orders: orders.results.map(row => JSON.parse(row.data_json)),
    products: products.results.map(row => JSON.parse(row.data_json)),
    inventory: JSON.parse(tenantResult.results[0].inventory_json || '{}'),
  };
  const items = rows.map(row => {
    const event = eventFromRow(row);
    return { ...event, currentStatus: notificationCurrentStatus(event, current) };
  });
  const hasMore = pageResult.results.length > PAGE_SIZE;
  return {
    items, unreadCount: countResult.results[0].unread_count,
    latestId: latestResult.results[0].latest_id,
    hasMore, nextCursor: hasMore ? items.at(-1).id : null,
  };
}

/** Personal read markers never mutate a business order, issue or revision. */
export async function markNotificationsRead(database, principal, body) {
  assertAdmin(principal);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(body))) fail('通知操作格式不正确。');
  if (Object.keys(body).some(key => !['ids', 'through', 'includeDemo'].includes(key))) fail('通知操作字段不正确。');
  if (own(body, 'ids') === own(body, 'through')) fail('请选择要标记的通知。');
  if (body.includeDemo != null && typeof body.includeDemo !== 'boolean') fail('演示通知筛选条件不正确。');
  const includeDemo = body.includeDemo === true;
  const db = latestDB(database);
  const timestamp = new Date().toISOString();
  let statement;
  if (own(body, 'ids')) {
    if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100) fail('每次可标记 1 至 100 条通知。');
    const ids = [...new Set(body.ids.map(id => positiveId(id)))];
    const encoded = JSON.stringify(ids);
    const found = await db.prepare('SELECT id FROM notification_events WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))')
      .bind(principal.tenantId, encoded).all();
    if (found.results.length !== ids.length) fail('通知不存在。', 404, 'NOTIFICATION_NOT_FOUND');
    statement = db.prepare(`INSERT OR IGNORE INTO notification_reads (tenant_id, user_id, event_id, read_at)
      SELECT tenant_id, ?, id, ? FROM notification_events WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .bind(principal.userId, timestamp, principal.tenantId, encoded);
  } else {
    const through = positiveId(body.through, true);
    // Capture the highest owned ID before writing. A forged future ID cannot
    // mark an event that arrives after this request's initial snapshot as read.
    const observed = await db.prepare(`SELECT coalesce(max(id), 0) AS latest_id FROM notification_events WHERE tenant_id = ? ${includeDemo ? '' : 'AND is_demo = 0'}`)
      .bind(principal.tenantId).first();
    const boundary = Math.min(through, observed.latest_id);
    statement = db.prepare(`INSERT OR IGNORE INTO notification_reads (tenant_id, user_id, event_id, read_at)
      SELECT tenant_id, ?, id, ? FROM notification_events WHERE tenant_id = ? AND id <= ? ${includeDemo ? '' : 'AND is_demo = 0'}`)
      .bind(principal.userId, timestamp, principal.tenantId, boundary);
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
