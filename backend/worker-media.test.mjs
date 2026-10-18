import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import worker from './worker.js';
import {ensureMaster} from './accounts.js';
import { KitchenModel } from '../data.js';
import { createCloudModel } from '../cloud-client.js';
import { seedTenant, loadState } from './repository.js';

let runtime, env;
const origin = 'https://kuraflow-media.test';
const token = '1'.repeat(64), otherToken = '2'.repeat(64);
before(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'store-media-test', modules:true, script:'export default {fetch(){return new Response("ok")}}',
    compatibilityDate:'2026-10-08', d1Databases:{DB:'store-media'}, kvNamespaces:['MEDIA'],
  }]}));
  const DB = await runtime.getD1Database('DB');
  for (const file of (await readdir(new URL('./migrations/', import.meta.url))).filter(f=>f.endsWith('.sql')).sort()) {
    await DB.exec((await readFile(new URL('./migrations/'+file, import.meta.url),'utf8')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  }
  for (const [tenantId, sessionToken] of [['media-a',token],['media-b',otherToken]]) {
    const model = new KitchenModel(); model.storage = null;
    model.state.products = []; model.state.orders = []; model.state.documents = [];
    model.state.stores = [{id:'store-a',name:'测试门店',city:'神户',address:'原有地址'}];
    await seedTenant(DB,{tenantId,state:model.state});
    const access = await ensureMaster(DB,{STORE_CODE_KEY:'3'.repeat(64)},tenantId);
    await DB.prepare('INSERT INTO account_sessions(hash,account_id,expires,version) VALUES (?,?,?,0)').bind(createHash('sha256').update(sessionToken).digest('hex'),access.account.id,Math.floor(Date.now()/1000)+600).run();
  }
  env = {DB,MEDIA:await runtime.getKVNamespace('MEDIA'),PUBLIC_ORIGIN:origin,LOCAL_TEST:'0',STORE_CODE_KEY:'3'.repeat(64)};
});
after(async()=>runtime?.dispose());
async function request(path, body, session = token, type = 'application/json') {
  return worker.fetch(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:'__Host-kuraflow_account='+session,'Content-Type':type},body:body===undefined?undefined:type==='application/json'?JSON.stringify(body):body}),env,{});
}
const edit = image => ({type:'updateStore',args:['store-a',{image}],idempotencyKey:crypto.randomUUID()});

test('store photo commands accept only uploaded images from the same company',async()=>{
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6BkAAAAASUVORK5CYII=','base64');
  const ownUpload = await request('/api/images',png,token,'image/png');
  assert.equal(ownUpload.status,201);
  const ownImage = (await ownUpload.json()).url;
  const foreignUpload = await request('/api/images',png,otherToken,'image/png');
  assert.equal(foreignUpload.status,201);
  const foreignImage = (await foreignUpload.json()).url;
  const before = await loadState(env.DB,'media-a');
  assert.equal((await request('/api/commands',edit(foreignImage))).status,403);
  assert.equal((await request('/api/commands',edit('data:image/png;base64,YWJj'))).status,400);
  assert.deepEqual(await loadState(env.DB,'media-a'),before);
  const saved = await request('/api/commands',edit(ownImage));
  assert.equal(saved.status,200);
  assert.equal((await saved.json()).result.image,ownImage);
  assert.equal((await request(ownImage)).status,200);
  assert.equal((await request(ownImage,undefined,otherToken)).status,404);
  const removed = await request('/api/commands',edit(null));
  assert.equal(removed.status,200);
  assert.equal((await removed.json()).result.image,null);
});

test('photo-bearing store saves reuse the upload and command after a lost or truncated success response',async()=>{
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  globalThis.window = new EventTarget();
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6BkAAAAASUVORK5CYII=';
  try {
    for (const failure of ['network', 'truncated']) {
      const session = await (await request('/api/state')).json();
      const client = createCloudModel(session);
      const before = await loadState(env.DB,'media-a');
      const commands = [];
      let uploads = 0, interrupted = false;
      globalThis.fetch = async (path, options = {}) => {
        const type = new Headers(options.headers).get('Content-Type') || 'application/json';
        const body = type === 'application/json' && options.body ? JSON.parse(options.body) : options.body;
        if (path === '/api/images') uploads++;
        if (path === '/api/commands') commands.push(body);
        const response = await request(path,body,token,type);
        if (path === '/api/commands' && !interrupted && response.ok) {
          interrupted = true;
          if (failure === 'network') throw new TypeError('Simulated response loss after commit');
          return new Response('{"result":', {status:200,headers:{'Content-Type':'application/json'}});
        }
        return response;
      };
      const details = {name:'图片重试门店 '+failure,prefectureCode:'27',municipalityCode:'27100',wardCode:'27111',addressDetail:'難波中1丁目2番3号',contact:'店长',phone:'090-1234-5678',image};
      await assert.rejects(client.addStore(details),failure === 'network' ? /网络连接中断/ : /未完整接收/);
      const committed = await loadState(env.DB,'media-a');
      assert.equal(committed.revision,before.revision+1);
      assert.equal(committed.state.stores.length,before.state.stores.length+1);
      const saved = await client.addStore(details);
      const after = await loadState(env.DB,'media-a');
      assert.equal(uploads,1);
      assert.equal(commands.length,2);
      assert.deepEqual(commands[1],commands[0]);
      assert.equal(after.revision,committed.revision);
      assert.equal(after.state.stores.length,committed.state.stores.length);
      assert.equal(saved.id,committed.state.stores.at(-1).id);
      assert.match(saved.accessCode,/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      assert.equal(client.state.stores.at(-1).image,saved.image);
      assert.equal(client.pending,0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
