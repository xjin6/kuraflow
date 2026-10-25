// Platform notifications read the existing append-only audit stream. The
// public payload is an allowlisted summary, never a raw account/audit record.
const PAGE_SIZE = 50;
const titles = {
  '开通中央厨房': '已开通客户',
  '更新客户配置': '客户配置已更新',
  '停用中央厨房': '客户已停用',
  '添加管理员': '已添加管理员',
  '修改管理员': '管理员资料已更新',
  '停用管理员': '管理员已停用',
  '启用管理员': '管理员已启用',
  '删除管理员': '管理员已删除',
  '恢复管理员': '管理员已恢复',
  '重置负责人码': '登录凭据已更新',
  '平台重置管理员密码': '登录凭据已更新',
  '修改自己的登录信息': '个人资料已更新',
  '更新个人头像': '个人头像已更新',
  '更新厨房头像': '客户头像已更新',
  'flow.connection.update': 'Flow 连接已更新',
  'flow.feature.enable': 'Flow 已启用',
  'flow.feature.disable': 'Flow 已停用',
  'ui.multilingual.enable': '多语言已启用',
  'ui.multilingual.disable': '多语言已停用',
  'portal.features.update': '端口功能已更新',
};
const actions = Object.keys(titles);
const actionFilter = `a.action IN (${actions.map(() => '?').join(',')})`;
const visibleScope = `(${actionFilter}) AND ((a.tenant_id IS NULL AND a.store_id IS NULL
  AND a.action NOT LIKE 'flow.%' AND a.action NOT LIKE 'ui.%' AND a.action <> 'portal.features.update')
  OR EXISTS (SELECT 1 FROM tenants owned_tenant WHERE owned_tenant.id = a.tenant_id))`;
const eventSource = 'platform_notification_events e JOIN account_audit a ON a.id = e.audit_id';
const fail = (message, status = 400, code = 'INVALID_NOTIFICATION') => {
  throw Object.assign(new Error(message), { status, code });
};
const countStatement = (db, principal) => db.prepare(`SELECT count(*) AS unread_count FROM ${eventSource}
  WHERE ${visibleScope} AND NOT EXISTS (SELECT 1 FROM platform_notification_reads r WHERE r.user_id = ? AND r.audit_id = a.id)`)
  .bind(...actions, principal.userId);

export async function listPlatformNotifications(db, principal, { filter, before }) {
  const [page, count, latest] = await db.batch([
    db.prepare(`SELECT e.id AS event_id, a.id AS audit_id, a.action, a.tenant_id, a.store_id,
      a.created_at, a.actor_name, t.name AS tenant_name, r.audit_id IS NOT NULL AS is_read
      FROM ${eventSource} LEFT JOIN tenants t ON t.id = a.tenant_id
      LEFT JOIN platform_notification_reads r ON r.audit_id = a.id AND r.user_id = ?
      WHERE ${visibleScope} ${filter === 'unread' ? 'AND r.audit_id IS NULL' : ''}
      ${before ? 'AND e.id < ?' : ''} ORDER BY e.id DESC LIMIT ?`)
      .bind(principal.userId, ...actions, ...(before ? [before] : []), PAGE_SIZE + 1),
    countStatement(db, principal),
    db.prepare(`SELECT coalesce(max(e.id), 0) AS latest_id FROM ${eventSource} WHERE ${visibleScope}`).bind(...actions),
  ]);
  const items = page.results.slice(0, PAGE_SIZE).map(row => ({
    id: row.event_id, kind: 'platform_activity', title: titles[row.action], titleKey: titles[row.action],
    body: '', bodyKey: row.tenant_id ? '客户：{0}' : '平台员工',
    bodyParams: row.tenant_id ? [row.tenant_name || row.tenant_id] : [],
    targetType: row.tenant_id ? 'customer' : 'team', targetId: row.tenant_id || 'platform',
    ...(row.tenant_id ? { tenantId: row.tenant_id } : {}),
    ...(row.store_id ? { storeId: row.store_id } : {}),
    createdAt: new Date(row.created_at * 1000).toISOString(), actorName: row.actor_name,
    read: row.is_read === 1, isDemo: false,
  }));
  const hasMore = page.results.length > PAGE_SIZE;
  return { items, unreadCount: count.results[0].unread_count, latestId: latest.results[0].latest_id,
    hasMore, nextCursor: hasMore ? items.at(-1).id : null };
}

export async function markPlatformNotificationsRead(db, principal, body) {
  const timestamp = new Date().toISOString();
  let statement;
  if (body.ids) {
    const encoded = JSON.stringify(body.ids);
    const found = await db.prepare(`SELECT e.id FROM ${eventSource} WHERE ${visibleScope}
      AND e.id IN (SELECT value FROM json_each(?))`).bind(...actions, encoded).all();
    if (found.results.length !== body.ids.length) fail('通知不存在。', 404, 'NOTIFICATION_NOT_FOUND');
    statement = db.prepare(`INSERT OR IGNORE INTO platform_notification_reads (user_id, audit_id, read_at)
      SELECT ?, a.id, ? FROM ${eventSource} WHERE ${visibleScope} AND e.id IN (SELECT value FROM json_each(?))`)
      .bind(principal.userId, timestamp, ...actions, encoded);
  } else {
    const latest = await db.prepare(`SELECT coalesce(max(e.id), 0) AS latest_id FROM ${eventSource} WHERE ${visibleScope}`)
      .bind(...actions).first();
    const boundary = Math.min(body.through, latest.latest_id);
    statement = db.prepare(`INSERT OR IGNORE INTO platform_notification_reads (user_id, audit_id, read_at)
      SELECT ?, a.id, ? FROM ${eventSource} WHERE ${visibleScope} AND e.id <= ?`)
      .bind(principal.userId, timestamp, ...actions, boundary);
  }
  const [, count] = await db.batch([statement, countStatement(db, principal)]);
  return { unreadCount: count.results[0].unread_count };
}
