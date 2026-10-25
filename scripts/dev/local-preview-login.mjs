import {randomBytes, createHash} from 'node:crypto';
import {getIdentity} from '../../backend/accounts.js';

export const previewPortals = new Set(['platform', 'kitchen', 'store']);
export function previewPortal(url) {
  const query = new URL(url).searchParams;
  return query.get('login') === 'platform' ? 'platform'
    : query.get('login') === 'store' || query.get('view') === 'client' ? 'store' : 'kitchen';
}
export function scopedPreviewHeaders(headers, portal) {
  const result = new Headers(headers);
  if (!previewPortals.has(portal)) return result;
  const cookies = (result.get('Cookie') || '').split(';').map(value => value.trim());
  const name = `kuraflow_preview_${portal}=`;
  const scoped = cookies.find(value => value.startsWith(name));
  result.delete('Cookie');
  if (scoped) result.set('Cookie', `kuraflow_local_account=${scoped.slice(name.length)}`);
  result.delete('X-Kuraflow-Preview-Portal');
  return result;
}
export function scopedPreviewCookie(cookie, portal) {
  return previewPortals.has(portal) ? cookie.replace(/^kuraflow_local_account=/, `kuraflow_preview_${portal}=`) : cookie;
}

// This module is imported only by the loopback development server, never by Worker code.
export async function loginToLocalPreview(request, {db, env}) {
  const url = new URL(request.url);
  const json = (body, status = 200, headers = {}) => Response.json(body, {status, headers: {'Cache-Control':'no-store', ...headers}});
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || env.LOCAL_TEST !== '1') return json({error:'仅用于本地预览。'}, 403);
  if (request.method !== 'POST') return json({error:'请使用预览按钮进入。'}, 405);
  if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({error:'请求来源不正确。'}, 403);
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({error:'请求格式不正确。'}, 415);
  const text = await request.text();
  if (text.length > 1024) return json({error:'请求过大。'}, 413);
  let portal;
  try { ({portal} = JSON.parse(text)); } catch { return json({error:'请求格式不正确。'}, 400); }
  if (!previewPortals.has(portal)) return json({error:'请选择有效的预览入口。'}, 400);
  const role = {platform:'platform', kitchen:'admin', store:'store'}[portal];
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date());
  const account = await db.prepare(`SELECT a.* FROM staff_accounts a
    LEFT JOIN organizations o ON o.tenant_id=a.tenant_id LEFT JOIN tenants t ON t.id=a.tenant_id
    WHERE a.role=? AND a.account_role='owner' AND a.status='active'
      AND (a.role='platform' OR (o.active=1 AND (o.expires_on IS NULL OR o.expires_on='' OR o.expires_on>=?)
        AND (a.role!='store' OR EXISTS (SELECT 1 FROM json_each(t.core_json,'$.stores') s
          WHERE json_extract(s.value,'$.id')=a.store_id AND json_extract(s.value,'$.deletedAt') IS NULL))))
    ORDER BY (a.tenant_id='local-demo-kitchen') DESC, (a.store_id='s-kobe') DESC, a.created_at, a.id LIMIT 1`).bind(role, today).first();
  if (!account) return json({error:'没有可用的本地演示账号，请先在本地平台开通。'}, 409);
  const token = randomBytes(32).toString('hex'), hash = createHash('sha256').update(token).digest('hex');
  const now = Math.floor(Date.now() / 1000), age = 86400;
  await db.prepare("INSERT INTO account_sessions(hash,account_id,expires,version) SELECT ?,id,?,version FROM staff_accounts WHERE id=? AND version=? AND status='active'").bind(hash, now + age, account.id, account.version).run();
  const principal = await getIdentity(new Request(url, {headers: {Cookie:`kuraflow_local_account=${token}`}}), env);
  if (!principal) { await db.prepare('DELETE FROM account_sessions WHERE hash=?').bind(hash).run(); return json({error:'本地账号已变更，请重试。'}, 409); }
  return json({ok:true, portal}, 200, {'Set-Cookie':`kuraflow_preview_${portal}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}`});
}
