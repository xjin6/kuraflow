import {handleFlow} from './flow-service.js';
import {handlePlatformFlow} from './flow-control.js';
import {handleAccounts,getIdentity,getStoreMasterCode,ensureMaster} from './accounts.js';
import { getState, getOrderHistory, executeCommand, getPrivateMaterials } from './repository.js';
import { getDocumentProfile, saveDocumentProfile } from './document-profile.js';
import { listNotifications, markNotificationsRead } from './notifications.js';
import {avatarRoutes,handleAvatars} from './avatars.js';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function json(data, status = 200) { return Response.json(data, { status, headers: { ...securityHeaders, 'Cache-Control': 'no-store' } }); }
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
async function readBytes(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) fail('上传内容过大。', 413);
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  let total = 0; const parts = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > limit) { await reader.cancel(); fail('上传内容过大。', 413); } parts.push(value); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
function mutationOrigin(request, env) {
  const url = new URL(request.url);
  const local = env.LOCAL_TEST === '1' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if ((!local && (!env.PUBLIC_ORIGIN || url.origin !== env.PUBLIC_ORIGIN)) || request.headers.get('Origin') !== url.origin) fail('请求来源不正确。', 403);
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') fail('拒绝跨站请求。', 403);
}
async function readJSON(request, limit = 262144) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail('请使用 JSON 请求。', 415);
  try { return JSON.parse(new TextDecoder().decode(await readBytes(request, limit))); } catch (e) { if (e.status) throw e; fail('请求格式不正确。'); }
}
async function uploadImage(request, env, principal) {
  if (principal.role !== 'admin') fail('仅管理员可上传图片。', 403);
  const mime = request.headers.get('Content-Type')?.split(';')[0];
  const data = await readBytes(request, 204800);
  const signature = mime === 'image/png' ? data[0] === 137 && data[1] === 80 && data[2] === 78 && data[3] === 71
    : mime === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
      : mime === 'image/webp' && new TextDecoder().decode(data.slice(0,4)) === 'RIFF' && new TextDecoder().decode(data.slice(8,12)) === 'WEBP';
  if (!signature || data.length < 16) fail('请上传有效的 JPEG、PNG 或 WebP 图片，压缩后最大 200 KB。');
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM media_files WHERE tenant_id=? AND created_at>=?").bind(principal.tenantId, new Date(Date.now()-86400000).toISOString()).first();
  if (recent.n >= 100) fail('今日上传数量已到上限，请明天再试。',429);
  const id = crypto.randomUUID(), key = principal.tenantId + '/' + id, stamp = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO media_usage(tenant_id,bytes) VALUES (?,0)').bind(principal.tenantId),
    env.DB.prepare('UPDATE media_usage SET bytes=bytes+? WHERE tenant_id=? AND bytes+?<=104857600').bind(data.length,principal.tenantId,data.length),
    env.DB.prepare('INSERT INTO media_assertions(id,ok) VALUES (?,changes())').bind(id),
    env.DB.prepare('INSERT INTO media_files(id,tenant_id,object_key,mime,bytes,created_at) VALUES (?,?,?,?,?,?)').bind(id,principal.tenantId,key,mime,data.length,stamp),
    env.DB.prepare('DELETE FROM media_assertions WHERE id=?').bind(id),
  ]);
  try { await env.MEDIA.put(key,data,{metadata:{mime}}); }
  catch(e) { await env.DB.batch([env.DB.prepare('DELETE FROM media_files WHERE id=? AND tenant_id=?').bind(id,principal.tenantId),env.DB.prepare('UPDATE media_usage SET bytes=bytes-? WHERE tenant_id=?').bind(data.length,principal.tenantId)]); throw e; }
  return json({id,url:'/api/images/'+id},201);
}
export default {
  async fetch(request,env,ctx) {
    const path = new URL(request.url).pathname;
    try {
      if (!path.startsWith('/api/')) {
        if (path.startsWith('/materials/') || ['business-data.js','data.js','app.js','business-ui.js'].includes(path.slice(1))) return json({error:'Not found'},404);
        const response = await env.ASSETS.fetch(request);
        const headers = new Headers(response.headers);
        for (const [name,value] of Object.entries(securityHeaders)) headers.set(name,value);
        headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
        return new Response(response.body,{status:response.status,headers});
      }
      if (path === '/api/health' && request.method === 'GET') return json({service:'kuraflow',status:'ready'});
      if(path.startsWith('/api/flow/'))return await handleFlow(request,env,ctx);
      const platformFlowResponse=await handlePlatformFlow(request,env,ctx);if(platformFlowResponse)return platformFlowResponse;
      if(avatarRoutes.has(path)){
        const avatarEnv=env.DB.withSession?{...env,DB:env.DB.withSession('first-primary')}:env;
        const actor=await getIdentity(request,avatarEnv);if(!actor)return json({error:'请先登录。'},401);
        return await handleAvatars(request,avatarEnv,actor);
      }
      const accountResponse=await handleAccounts(request,env);if(accountResponse)return accountResponse;
      if (path.startsWith('/api/auth/')) return json({error:'请使用新的登录入口。'},410);
      // Read markers and their identity check share a session beginning at the
      // primary, so suspended accounts and recent events are not read stale.
      const notificationRoute = path === '/api/notifications' || path === '/api/notifications/read';
      const requestEnv = notificationRoute && env.DB.withSession ? { ...env, DB: env.DB.withSession('first-primary') } : env;
      const principal = await getIdentity(request,requestEnv);
      if (!principal) return json({error:'请先登录。'},401);
      if (principal.role==='platform') return json({error:'平台账号请使用客户管理入口。'},403);
      if (request.method === 'GET' && path === '/api/notifications') return json(await listNotifications(requestEnv.DB,principal,new URL(request.url).searchParams));
      if (request.method === 'GET' && path === '/api/state') return json({...await getState(env.DB,principal),principal});
      if (request.method === 'GET' && path === '/api/document-profile') return json(await getDocumentProfile(env.DB,principal));
      if (request.method === 'GET' && path === '/api/order-history') {
        const params=new URL(request.url).searchParams;
        return json(await getOrderHistory(env.DB,principal,{cursor:Number(params.get('cursor')||0),revision:params.has('revision')?Number(params.get('revision')):undefined}));
      }
      if (request.method === 'GET' && path === '/api/admin/materials') {
        if (principal.role !== 'admin') fail('无权访问。',403);
        return json(await getPrivateMaterials(env.DB,principal));
      }
      if (request.method === 'GET' && /^\/api\/images\/[a-f0-9-]{36}$/.test(path)) {
        const file = await env.DB.prepare('SELECT object_key,mime FROM media_files WHERE id=? AND tenant_id=?').bind(path.split('/').at(-1),principal.tenantId).first();
        if (!file) return json({error:'Not found'},404);
        const body = await env.MEDIA.get(file.object_key,'arrayBuffer');
        if (!body) return json({error:'图片正在同步，请稍后刷新。'},404);
        return new Response(body,{headers:{...securityHeaders,'Content-Type':file.mime,'Cache-Control':'private, max-age=86400'}});
      }
      if (request.method !== 'POST') return json({error:'Not found'},404);
      mutationOrigin(request,env);
      if (path === '/api/notifications/read') return json(await markNotificationsRead(requestEnv.DB,principal,await readJSON(request,8192)));
      if (path === '/api/document-profile') return json(await saveDocumentProfile(env.DB,principal,await readJSON(request,8192)));
      if (path === '/api/images') return await uploadImage(request,env,principal);
      if (path === '/api/commands') {
        const command = await readJSON(request);
        const image = ['addProduct', 'addStore', 'updateStore'].includes(command?.type)
          ? command.args?.[command.type === 'updateStore' ? 1 : 0]?.image : null;
        if (image) {
          const url = image;
          if (!/^\/api\/images\/[a-f0-9-]{36}$/.test(url)) fail('图片必须先上传。');
          const own = await env.DB.prepare('SELECT id FROM media_files WHERE id=? AND tenant_id=?').bind(url.split('/').at(-1),principal.tenantId).first();
          if (!own) fail('无权使用该图片。',403);
        }
        const result = await executeCommand(env.DB,principal,command);
        if (command.type === 'addStore') {
          // Provisioning is idempotent. Retrying the same command repairs an
          // interrupted code creation without making a second business store.
          const master = await ensureMaster(env.DB,env,principal.tenantId,result.result.id);
          if(principal.accountRole==='owner') result.result = { ...result.result, accessCode:master.masterCode };
        }
        return json(result);
      }
      if (path === '/api/admin/store-code') {
        if (principal.role !== 'admin') fail('仅管理员可管理门店识别码。',403);
        const body = await readJSON(request,4096);
        return json(await getStoreMasterCode(env.DB,env,principal,body.storeId));
      }
      return json({error:'Not found'},404);
    } catch(error) {
      const status = Number(error.status || error.statusCode) || 500;
      if (status >= 500) console.error(JSON.stringify({event:'request_failed',path,status,code:error.code || 'internal'}));
      return json({error:status<500 ? error.message : '服务暂时不可用，请稍后重试。',code:error.code},status);
    }
  },
};
