import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import {readFile, readdir} from 'node:fs/promises';
import {Miniflare, convertV4MiniflareOptions} from 'miniflare';
import worker from '../../backend/worker.js';
import {provisionPlatform} from '../../backend/accounts.js';
import {hashToken} from '../../backend/auth.js';

const origin = 'https://accounts.example';
const password = 'Test-only member password 2026!';
let runtime, env, platform, platformCredential, counter = 0;

before(async () => {
  runtime = new Miniflare(convertV4MiniflareOptions({workers:[{
    name:'accounts-tests', modules:true,
    script:'export default {fetch(){return new Response("ok")}}',
    compatibilityDate:'2026-10-08', d1Databases:{DB:'accounts'},
  }]}));
  const DB = await runtime.getD1Database('DB');
  const migrations = (await readdir(new URL('../../backend/migrations/', import.meta.url))).filter(name => name.endsWith('.sql')).sort();
  for (const name of migrations) {
    const sql = await readFile(new URL('../../backend/migrations/' + name, import.meta.url), 'utf8');
    await DB.exec(sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' '));
  }
  env = {DB, PUBLIC_ORIGIN:origin, LOCAL_TEST:'0', STORE_CODE_KEY:'1'.repeat(64)};
  platformCredential = await provisionPlatform(DB, {});
  platform = expectStatus(await call('/api/accounts/platform-login', {key:platformCredential.platformKey}), 200).cookie;
});
after(async () => runtime?.dispose());

async function call(path, body, cookie = '', headers = {}) {
  const response = await worker.fetch(new Request(origin + path, {
    method:body === undefined ? 'GET' : 'POST',
    headers:{Origin:origin, 'Content-Type':'application/json', 'CF-Connecting-IP':`198.51.${Math.floor(++counter / 240)}.${counter % 240 + 1}`, Cookie:cookie, ...headers},
    ...(body === undefined ? {} : {body:JSON.stringify(body)}),
  }), env, {});
  return {status:response.status, data:await response.json(), cookie:response.headers.get('Set-Cookie')?.split(';')[0], headers:response.headers};
}
function expectStatus(result, status) {
  assert.equal(result.status, status, JSON.stringify(result.data));
  return result;
}
function assertMasterCode(code) {
  assert.match(code, /^(?:[A-Z0-9]{4}-){3}[A-Z0-9]{4}$/);
  assert.match(code, /[A-Z]/);
  assert.match(code, /\d/);
}
async function loginOwner(code, portal = 'kitchen') {
  return expectStatus(await call('/api/accounts/master-login', {code, portal}), 200).cookie;
}
async function loginMember(username, portal = 'kitchen', secret = password) {
  return expectStatus(await call('/api/accounts/login', {username, password:secret, portal}), 200).cookie;
}
async function authenticated(cookie) {
  return expectStatus(await call('/api/accounts/session', undefined, cookie), 200).data.authenticated;
}
async function kitchenFixture(label) {
  const body = {requestId:crypto.randomUUID(), name:label, ownerName:'厨房负责人', contact:'owner@example.test'};
  const result = expectStatus(await call('/api/platform/create', body, platform), 201).data;
  return {...result, body, cookie:await loginOwner(result.masterCode)};
}
function storeCommand(name) {
  return {type:'addStore', args:[{name, prefectureCode:'27', municipalityCode:'27100', wardCode:'27128', addressDetail:'難波1-1', contact:'店长', phone:'090-2222-3333'}], idempotencyKey:crypto.randomUUID()};
}
async function storeFixture(kitchen, label = '测试门店') {
  const command = storeCommand(label);
  const result = expectStatus(await call('/api/commands', command, kitchen.cookie), 200).data.result;
  return {...result, command, masterCode:result.accessCode, cookie:await loginOwner(result.accessCode, 'store')};
}
async function addMember(cookie, options = {}) {
  const body = {username:`member-${++counter}`, name:'管理员', password, requestId:crypto.randomUUID(), ...options};
  const result = expectStatus(await call('/api/team/create', body, cookie), 201).data;
  return {...result, body};
}

test('platform uses only its secret key and does not expose or store a recoverable key or password', async () => {
  const login = expectStatus(await call('/api/accounts/platform-login', {key:platformCredential.platformKey}), 200);
  assert.equal(login.data.principal.role, 'platform');
  assert.equal(login.data.principal.username, null);
  assert.match(login.headers.get('Set-Cookie'), /^__Host-kuraflow_account=[a-f0-9]{64};/);
  for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(login.headers.get('Set-Cookie').includes(attribute));
  const row = await env.DB.prepare('SELECT a.password_hash,k.key_hash,k.key_cipher FROM staff_accounts a JOIN account_keys k ON k.account_id=a.id WHERE a.id=?').bind(platformCredential.account.id).first();
  assert.equal(row.password_hash, null);
  assert.equal(row.key_cipher, null);
  assert.equal(row.key_hash, await hashToken(platformCredential.platformKey));
  assert.ok(!JSON.stringify(row).includes(platformCredential.platformKey));
  const repeated = await provisionPlatform(env.DB, {key:platformCredential.platformKey});
  assert.equal(repeated.account.id, platformCredential.account.id);
  assert.equal(repeated.platformKey, undefined);
  await assert.rejects(provisionPlatform(env.DB, {key:'x'.repeat(80)}), {status:409});
  expectStatus(await call('/api/accounts/platform-login', {password:platformCredential.platformKey}), 401);
  expectStatus(await call('/api/accounts/platform-login', {key:'wrong'.repeat(20)}), 401);
  expectStatus(await call('/api/accounts/login', {username:'platform', password:platformCredential.platformKey, portal:'kitchen'}), 401);
  expectStatus(await call('/api/accounts/platform-login', {key:platformCredential.platformKey}, '', {Origin:'https://evil.example'}), 403);
  expectStatus(await call('/api/state', undefined, login.cookie), 403);
  expectStatus(await call('/api/platform/kitchens', undefined, login.cookie), 200);
  expectStatus(await call('/api/accounts/activate', {token:'old-invitation', password}), 404);
  expectStatus(await call('/api/auth/store-code', {accessCode:'old-code'}), 410);
  expectStatus(await call('/api/accounts/logout', {}, login.cookie), 200);
  assert.equal(await authenticated(login.cookie), false);
  assert.equal(await authenticated(platform), true);
});

test('kitchen creation and retries yield one encrypted owner code with no owner password', async () => {
  const kitchen = await kitchenFixture('重复开通厨房');
  assertMasterCode(kitchen.masterCode);
  assert.equal(kitchen.account.accountRole, 'owner');
  assert.equal(kitchen.account.username, null);
  const repeats = await Promise.all(Array.from({length:3}, () => call('/api/platform/create', kitchen.body, platform)));
  for (const result of repeats) {
    expectStatus(result, 201);
    assert.equal(result.data.tenantId, kitchen.tenantId);
    assert.equal(result.data.account.id, kitchen.account.id);
    assert.equal(result.data.masterCode, kitchen.masterCode);
  }
  const row = await env.DB.prepare('SELECT a.password_hash,k.key_hash,k.key_cipher FROM staff_accounts a JOIN account_keys k ON k.account_id=a.id WHERE a.id=?').bind(kitchen.account.id).first();
  assert.equal(row.password_hash, null);
  assert.equal(row.key_hash, await hashToken(kitchen.masterCode));
  assert.ok(row.key_cipher.length > kitchen.masterCode.length);
  assert.ok(!row.key_cipher.includes(kitchen.masterCode));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM staff_accounts WHERE tenant_id=?').bind(kitchen.tenantId).first()).n, 1);
  const normalized = await loginOwner(kitchen.masterCode.toLowerCase().replaceAll('-', ' '));
  const state = expectStatus(await call('/api/state', undefined, normalized), 200).data;
  assert.equal(state.principal.tenantId, kitchen.tenantId);
  assert.equal(state.principal.accountRole, 'owner');
  assert.deepEqual(state.state.orders, []);
  expectStatus(await call('/api/accounts/master-login', {code:kitchen.masterCode, portal:'store'}), 401);
  expectStatus(await call('/api/accounts/master-login', {code:kitchen.masterCode}), 401);
  expectStatus(await call('/api/accounts/profile', {oldPassword:password, username:'owner-password', password}, kitchen.cookie), 403);
  expectStatus(await call('/api/platform/kitchens', undefined, kitchen.cookie), 403);
  assert.equal(expectStatus(await call('/api/team/master-key', {}, kitchen.cookie), 200).data.masterCode, kitchen.masterCode);
});

test('adding a store automatically creates its owner and retries preserve the store and code', async () => {
  const kitchen = await kitchenFixture('门店开通厨房');
  const store = await storeFixture(kitchen);
  assertMasterCode(store.masterCode);
  const repeated = expectStatus(await call('/api/commands', store.command, kitchen.cookie), 200).data.result;
  assert.equal(repeated.id, store.id);
  assert.equal(repeated.accessCode, store.masterCode);
  const rows = await env.DB.prepare("SELECT * FROM staff_accounts WHERE tenant_id=? AND store_id=? AND account_role='owner'").bind(kitchen.tenantId, store.id).all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].password_hash, null);
  assert.equal(rows.results[0].status, 'active');
  const team = expectStatus(await call('/api/team/list', undefined, store.cookie), 200).data;
  assert.equal(team.accounts.length, 1);
  assert.equal(team.accounts[0].id, rows.results[0].id);
  assert.equal(team.limit, null);
  const state = expectStatus(await call('/api/state', undefined, store.cookie), 200).data;
  assert.deepEqual(state.state.stores.map(item => item.id), [store.id]);
  assert.equal(state.principal.storeId, store.id);
  expectStatus(await call('/api/accounts/master-login', {code:store.masterCode, portal:'kitchen'}), 401);
  assert.equal(expectStatus(await call('/api/admin/store-code', {storeId:store.id}, kitchen.cookie), 200).data.accessCode, store.masterCode);
});

test('concurrent creation permits more than three kitchen admins while retaining isolation and idempotency', async () => {
  const kitchen = await kitchenFixture('厨房管理员名额');
  const bodies = Array.from({length:4}, (_,index) => ({username:`quota-${counter}-${index}`, password, requestId:crypto.randomUUID()}));
  const results = await Promise.all(bodies.map(body => call('/api/team/create', body, kitchen.cookie)));
  assert.deepEqual(results.map(result => result.status).sort(), [201, 201, 201, 201]);
  const team = expectStatus(await call('/api/team/list', undefined, kitchen.cookie), 200).data;
  assert.equal(team.limit, null);
  assert.equal(team.accounts.length, 5);
  assert.equal(team.accounts.filter(account => account.accountRole === 'owner').length, 1);
  assert.equal(team.accounts.filter(account => account.accountRole === 'member').length, 4);
  const accepted = results.findIndex(result => result.status === 201);
  const repeated = expectStatus(await call('/api/team/create', bodies[accepted], kitchen.cookie), 201);
  assert.equal(repeated.data.account.id, results[accepted].data.account.id);
  const memberCookie = await loginMember(results[accepted].data.account.username);
  expectStatus(await call('/api/team/create', {username:'unauthorized-member', password}, memberCookie), 403);
  const rows = await env.DB.prepare("SELECT password_hash FROM staff_accounts WHERE tenant_id=? AND account_role='member'").bind(kitchen.tenantId).all();
  assert.equal(rows.results.length, 4);
  for (const row of rows.results) assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!JSON.stringify(rows).includes(password));
  assert.ok(!JSON.stringify(team).includes('password_hash'));
});

test('member usernames are normalized and globally unique across kitchens and stores, with separate portals', async () => {
  const first = await kitchenFixture('账号命名厨房甲');
  const second = await kitchenFixture('账号命名厨房乙');
  const store = await storeFixture(first);
  const submitted = ` Ｍｉｘｅｄ.Staff-${counter} `;
  const member = await addMember(first.cookie, {username:submitted});
  const normalized = submitted.normalize('NFKC').trim().toLowerCase();
  assert.equal(member.account.username, normalized);
  const kitchenCookie = await loginMember(submitted);
  for (const cookie of [second.cookie, store.cookie]) expectStatus(await call('/api/team/create', {username:normalized.toUpperCase(), password}, cookie), 409);
  expectStatus(await call('/api/team/create', {username:`short-${counter}`, password:'short'}, second.cookie), 400);
  expectStatus(await call('/api/accounts/login', {username:normalized, password:'incorrect password', portal:'kitchen'}), 401);
  expectStatus(await call('/api/accounts/login', {username:normalized, password, portal:'store'}), 401);
  const storeMember = await addMember(store.cookie);
  const storeCookie = await loginMember(storeMember.account.username, 'store');
  expectStatus(await call('/api/accounts/login', {username:storeMember.account.username, password, portal:'kitchen'}), 401);
  assert.equal((await call('/api/state', undefined, kitchenCookie)).data.principal.role, 'admin');
  assert.equal((await call('/api/state', undefined, storeCookie)).data.principal.role, 'store');
});

test('members cannot retrieve or rotate master codes, including through addStore responses', async () => {
  const kitchen = await kitchenFixture('主码保密厨房');
  const store = await storeFixture(kitchen);
  const kitchenMember = await addMember(kitchen.cookie);
  const storeMember = await addMember(store.cookie);
  const kitchenCookie = await loginMember(kitchenMember.account.username);
  const storeCookie = await loginMember(storeMember.account.username, 'store');
  for (const cookie of [kitchenCookie, storeCookie]) {
    for (const rotate of [false, true]) expectStatus(await call('/api/team/master-key', {tenantId:kitchen.tenantId, storeId:store.id, rotate}, cookie), 403);
    expectStatus(await call('/api/admin/store-code', {storeId:store.id}, cookie), 403);
    expectStatus(await call('/api/team/audit', undefined, cookie), 403);
    for (const path of ['/api/accounts/session', '/api/team/list', '/api/state']) {
      const result = expectStatus(await call(path, undefined, cookie), 200);
      assert.ok(!JSON.stringify(result.data).includes(kitchen.masterCode));
      assert.ok(!JSON.stringify(result.data).includes(store.masterCode));
      assert.ok(!/key_cipher|key_hash|password_hash/.test(JSON.stringify(result.data)));
    }
  }
  const command = storeCommand('管理员添加的门店');
  for (let attempt = 0; attempt < 2; attempt++) {
    const created = expectStatus(await call('/api/commands', command, kitchenCookie), 200).data.result;
    assert.equal(created.accessCode, undefined);
    assert.equal(created.masterCode, undefined);
    const reveal = expectStatus(await call('/api/admin/store-code', {storeId:created.id}, kitchen.cookie), 200);
    assertMasterCode(reveal.data.accessCode);
    assert.equal(await authenticated(await loginOwner(reveal.data.accessCode, 'store')), true);
  }
});

test('tenant and store scopes are taken from the session despite foreign scope parameters', async () => {
  const first = await kitchenFixture('隔离厨房甲');
  const second = await kitchenFixture('隔离厨房乙');
  const firstStore = await storeFixture(first, '甲门店一');
  const siblingStore = await storeFixture(first, '甲门店二');
  const foreignStore = await storeFixture(second, '乙门店');
  const ownMember = await addMember(firstStore.cookie, {tenantId:second.tenantId, storeId:foreignStore.id});
  const siblingMember = await addMember(siblingStore.cookie);
  const foreignMember = await addMember(foreignStore.cookie);
  assert.equal(ownMember.account.tenantId, first.tenantId);
  assert.equal(ownMember.account.storeId, firstStore.id);
  const list = expectStatus(await call(`/api/team/list?tenant=${second.tenantId}&store=${foreignStore.id}`, undefined, firstStore.cookie), 200).data;
  assert.equal(list.storeId, firstStore.id);
  assert.deepEqual(list.stores.map(store => store.id), [firstStore.id]);
  assert.ok(list.accounts.every(account => account.tenantId === first.tenantId && account.storeId === firstStore.id));
  const ignored = expectStatus(await call('/api/team/master-key', {tenantId:second.tenantId, storeId:foreignStore.id}, firstStore.cookie), 200);
  assert.equal(ignored.data.masterCode, firstStore.masterCode);
  for (const target of [siblingMember, foreignMember]) assert.ok([403, 404].includes((await call('/api/team/update', {id:target.account.id, action:'disable'}, firstStore.cookie)).status));
  assert.ok([403, 404].includes((await call('/api/team/update', {id:foreignMember.account.id, action:'disable'}, first.cookie)).status));
  // Store identifiers may repeat across tenants; the session still selects its own store.
  assert.equal(firstStore.id, foreignStore.id);
  const sameId = expectStatus(await call('/api/team/master-key', {tenantId:second.tenantId, storeId:foreignStore.id}, first.cookie), 200);
  assert.equal(sameId.data.masterCode, firstStore.masterCode);
  assert.notEqual(sameId.data.masterCode, foreignStore.masterCode);
  expectStatus(await call('/api/team/master-key', {storeId:'missing-store'}, first.cookie), 404);
  expectStatus(await call('/api/commands', storeCommand('越权门店'), firstStore.cookie), 403);
  const memberCookie = await loginMember(ownMember.account.username, 'store');
  const state = expectStatus(await call(`/api/state?tenant=${second.tenantId}&store=${foreignStore.id}`, undefined, memberCookie), 200).data;
  assert.deepEqual(state.state.stores.map(store => store.id), [firstStore.id]);
  expectStatus(await call('/api/commands', {type:'submitOrder', args:[siblingStore.id, {}, '2099-01-01'], expectedQuotes:{}, idempotencyKey:crypto.randomUUID()}, memberCookie), 403);
});

test('owner code rotation invalidates only that owner and preserves member sessions', async () => {
  const kitchen = await kitchenFixture('主码重置厨房');
  const store = await storeFixture(kitchen);
  const kitchenMember = await addMember(kitchen.cookie);
  const storeMember = await addMember(store.cookie);
  const kitchenMemberCookie = await loginMember(kitchenMember.account.username);
  const storeMemberCookie = await loginMember(storeMember.account.username, 'store');
  const secondOwnerSession = await loginOwner(kitchen.masterCode);
  expectStatus(await call('/api/team/master-key', {rotate:true}, kitchen.cookie), 403);
  expectStatus(await call('/api/team/master-key', {rotate:true}, store.cookie), 403);
  const rotated = expectStatus(await call('/api/team/master-key', {tenantId:kitchen.tenantId, rotate:true}, platform), 200).data;
  assertMasterCode(rotated.masterCode);
  assert.notEqual(rotated.masterCode, kitchen.masterCode);
  for (const cookie of [kitchen.cookie, secondOwnerSession]) assert.equal(await authenticated(cookie), false);
  for (const cookie of [kitchenMemberCookie, store.cookie, storeMemberCookie]) assert.equal(await authenticated(cookie), true);
  expectStatus(await call('/api/accounts/master-login', {code:kitchen.masterCode, portal:'kitchen'}), 401);
  const renewedOwner = await loginOwner(rotated.masterCode);
  const storeRotated = expectStatus(await call('/api/team/master-key', {storeId:store.id, rotate:true}, renewedOwner), 200).data;
  assert.notEqual(storeRotated.masterCode, store.masterCode);
  assert.equal(await authenticated(store.cookie), false);
  for (const cookie of [renewedOwner, kitchenMemberCookie, storeMemberCookie]) assert.equal(await authenticated(cookie), true);
  expectStatus(await call('/api/accounts/master-login', {code:store.masterCode, portal:'store'}), 401);
  assert.equal(await authenticated(await loginOwner(storeRotated.masterCode, 'store')), true);
});

test('members can change their own username and password, with collisions rejected and sessions revoked', async () => {
  const kitchen = await kitchenFixture('修改登录信息厨房');
  const member = await addMember(kitchen.cookie);
  const other = await addMember(kitchen.cookie);
  const firstSession = await loginMember(member.account.username);
  const secondSession = await loginMember(member.account.username);
  const newUsername = `renamed-${counter}`;
  const newPassword = 'Changed member password 2026!';
  expectStatus(await call('/api/accounts/profile', {oldPassword:'wrong password', username:newUsername, password:newPassword}, firstSession), 400);
  expectStatus(await call('/api/accounts/profile', {oldPassword:password, username:other.account.username.toUpperCase(), password:newPassword}, firstSession), 409);
  assert.equal(await authenticated(firstSession), true);
  const changed = expectStatus(await call('/api/accounts/profile', {id:other.account.id, oldPassword:password, username:newUsername, password:newPassword}, firstSession), 200);
  assert.match(changed.headers.get('Set-Cookie'), /Max-Age=0/);
  for (const cookie of [firstSession, secondSession]) assert.equal(await authenticated(cookie), false);
  expectStatus(await call('/api/accounts/login', {username:member.account.username, password, portal:'kitchen'}), 401);
  expectStatus(await call('/api/accounts/login', {username:newUsername, password, portal:'kitchen'}), 401);
  const renewed = await loginMember(newUsername, 'kitchen', newPassword);
  assert.equal((await call('/api/accounts/session', undefined, renewed)).data.principal.id, member.account.id);
  assert.equal(await authenticated(await loginMember(other.account.username)), true);
  const usernameOnly = `renamed-again-${counter}`;
  expectStatus(await call('/api/accounts/profile', {oldPassword:newPassword, username:usernameOnly}, renewed), 200);
  assert.equal(await authenticated(renewed), false);
  assert.equal(await authenticated(await loginMember(usernameOnly, 'kitchen', newPassword)), true);
});

test('store admins can exceed three and re-enable accounts without a seat cap', async () => {
  const kitchen = await kitchenFixture('门店名额厨房');
  const store = await storeFixture(kitchen);
  const members = [];
  for (let index = 0; index < 3; index++) members.push(await addMember(store.cookie));
  const memberCookie = await loginMember(members[0].account.username, 'store');
  expectStatus(await call('/api/team/create', {username:`full-${counter}`, password}, store.cookie), 201);
  const team = expectStatus(await call('/api/team/list', undefined, store.cookie), 200).data;
  assert.equal(team.accounts.length, 5);
  const owner = team.accounts.find(account => account.accountRole === 'owner');
  expectStatus(await call('/api/team/update', {id:owner.id, action:'disable'}, store.cookie), 403);
  expectStatus(await call('/api/team/update', {id:members[0].account.id, action:'disable'}, store.cookie), 200);
  assert.equal(await authenticated(memberCookie), false);
  expectStatus(await call('/api/accounts/login', {username:members[0].account.username, password, portal:'store'}), 401);
  const replacement = await addMember(store.cookie);
  expectStatus(await call('/api/team/update', {id:members[0].account.id, action:'enable'}, store.cookie), 200);
  expectStatus(await call('/api/team/update', {id:replacement.account.id, action:'disable'}, store.cookie), 200);
  expectStatus(await call('/api/team/update', {id:members[0].account.id, action:'enable'}, store.cookie), 200);
  assert.equal(await authenticated(await loginMember(members[0].account.username, 'store')), true);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM staff_accounts WHERE tenant_id=? AND store_id=? AND account_role='member' AND status='active'").bind(kitchen.tenantId, store.id).first()).n, 4);
  assert.equal((await addMember(kitchen.cookie)).account.storeId, null);
});

test('tenant suspension revokes all owner and member sessions while retaining data and unrelated access', async () => {
  const kitchen = await kitchenFixture('停用厨房');
  const unaffected = await kitchenFixture('正常厨房');
  const store = await storeFixture(kitchen);
  const member = await addMember(kitchen.cookie);
  const storeMember = await addMember(store.cookie);
  const memberCookie = await loginMember(member.account.username);
  const storeMemberCookie = await loginMember(storeMember.account.username, 'store');
  expectStatus(await call('/api/platform/update', {id:kitchen.tenantId, active:false}, kitchen.cookie), 403);
  expectStatus(await call('/api/platform/update', {id:kitchen.tenantId, active:false}, platform), 200);
  for (const cookie of [kitchen.cookie, store.cookie, memberCookie, storeMemberCookie]) {
    assert.equal(await authenticated(cookie), false);
    expectStatus(await call('/api/state', undefined, cookie), 401);
  }
  for (const [code, portal] of [[kitchen.masterCode, 'kitchen'], [store.masterCode, 'store']]) expectStatus(await call('/api/accounts/master-login', {code, portal}), 403);
  for (const [username, portal] of [[member.account.username, 'kitchen'], [storeMember.account.username, 'store']]) expectStatus(await call('/api/accounts/login', {username, password, portal}), 403);
  assert.equal(await authenticated(unaffected.cookie), true);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM staff_accounts WHERE tenant_id=?').bind(kitchen.tenantId).first()).n, 4);
  expectStatus(await call('/api/platform/update', {id:kitchen.tenantId, active:true}, platform), 200);
  assert.equal(await authenticated(kitchen.cookie), false);
  assert.equal(await authenticated(memberCookie), false);
  const restored = await loginOwner(kitchen.masterCode);
  assert.deepEqual((await call('/api/state', undefined, restored)).data.state.stores.map(item => item.id), [store.id]);
  assert.equal(await authenticated(await loginMember(member.account.username)), true);
  const audit = expectStatus(await call('/api/team/audit', undefined, restored), 200).data;
  assert.ok(audit.events.some(event => event.action === '停用中央厨房'));
  assert.ok(!JSON.stringify(audit).includes(kitchen.masterCode));
  assert.ok(!JSON.stringify(audit).includes(password));
});

test('legacy encrypted store codes migrate into owner keys idempotently and revoke password-era sessions', async () => {
  const kitchen = await kitchenFixture('旧版迁移厨房');
  const store = await storeFixture(kitchen);
  const account = await env.DB.prepare("SELECT * FROM staff_accounts WHERE tenant_id=? AND store_id=? AND account_role='owner'").bind(kitchen.tenantId, store.id).first();
  const legacyCode = '1ABC-2DEF-3456-7890';
  const key = await crypto.subtle.importKey('raw', Buffer.from(env.STORE_CODE_KEY, 'hex'), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData:new TextEncoder().encode(JSON.stringify([kitchen.tenantId, store.id]))}, key, new TextEncoder().encode(legacyCode));
  const legacyUser = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM account_keys WHERE account_id=?').bind(account.id),
    env.DB.prepare('UPDATE staff_accounts SET login_id=?,password_hash=? WHERE id=?').bind('1234567890123456', 'legacy-password-hash', account.id),
    env.DB.prepare("INSERT INTO users(id,tenant_id,role,store_id,display_name,created_at) VALUES(?,?,'store',?,'旧门店负责人',?)").bind(legacyUser, kitchen.tenantId, store.id, Math.floor(Date.now() / 1000)),
    env.DB.prepare('INSERT INTO store_access_codes(tenant_id,store_id,user_id,code_hash,code_cipher,created_at) VALUES(?,?,?,?,?,?)').bind(kitchen.tenantId, store.id, legacyUser, await hashToken(legacyCode), Buffer.concat([iv, Buffer.from(encrypted)]).toString('base64url'), Math.floor(Date.now() / 1000)),
    env.DB.prepare('INSERT INTO account_invites(hash,account_id,expires,version) VALUES(?,?,?,?)').bind(await hashToken('legacy-invite'), account.id, Math.floor(Date.now() / 1000) + 3600, account.version),
  ]);
  assert.equal(await authenticated(store.cookie), true);
  expectStatus(await call('/api/platform/upgrade-existing', {}, platform), 200);
  assert.equal(await authenticated(store.cookie), false);
  const reveal = expectStatus(await call('/api/team/master-key', {storeId:store.id}, kitchen.cookie), 200).data;
  assert.equal(reveal.masterCode, legacyCode);
  assert.equal(reveal.account.id, account.id);
  const migrated = await env.DB.prepare('SELECT password_hash,version FROM staff_accounts WHERE id=?').bind(account.id).first();
  assert.equal(migrated.password_hash, null);
  assert.equal(migrated.version, account.version + 1);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM account_invites WHERE account_id=?').bind(account.id).first()).n, 0);
  const session = await loginOwner(legacyCode, 'store');
  expectStatus(await call('/api/platform/upgrade-existing', {}, platform), 200);
  assert.equal(await authenticated(session), true);
  assert.equal(expectStatus(await call('/api/admin/store-code', {storeId:store.id}, kitchen.cookie), 200).data.accessCode, legacyCode);
  expectStatus(await call('/api/accounts/login', {username:'1234567890123456', password, portal:'store'}), 401);
});
