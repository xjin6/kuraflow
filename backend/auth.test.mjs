import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import { createInvite, getPrincipal, handleAuth, hashToken, getStoreAccessCode } from './auth.js';

// Real SQLite executes the same migration and transaction SQL as D1. WebAuthn
// messages below use real P-256 keys and signed assertions; no verifier mocks.
class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(readFileSync(new URL('./migrations/0001_business.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('./migrations/0002_auth.sql', import.meta.url), 'utf8'));
    this.sqlite.exec(readFileSync(new URL('./migrations/0004_store_codes.sql', import.meta.url), 'utf8'));
    this.sqlite.prepare('INSERT INTO tenants(id, name, core_json) VALUES (?, ?, ?)')
      .run('tenant-a', 'Test kitchen', JSON.stringify({ stores: [{ id: 'store-a' }] }));
    this.sqlite.prepare('INSERT INTO tenants(id, name, core_json) VALUES (?, ?, ?)')
      .run('tenant-b', 'Other kitchen', JSON.stringify({ stores: [{ id: 'store-b' }] }));
  }
  prepare(sql) {
    const sqlite = this.sqlite;
    const statement = (args = []) => ({
      bind: (...values) => statement(values),
      first: async () => sqlite.prepare(sql).get(...args) || null,
      run: async () => ({ success: true, meta: sqlite.prepare(sql).run(...args) }),
      sync: () => ({ success: true, meta: sqlite.prepare(sql).run(...args) }),
    });
    return statement();
  }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const result = statements.map((statement) => statement.sync());
      this.sqlite.exec('COMMIT');
      return result;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  get(sql, ...args) { return this.sqlite.prepare(sql).get(...args); }
}

const origin = 'https://kuraflow.example.com';
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest();
let requestNumber = 0;
function env() { return { DB: new D1(), PUBLIC_ORIGIN: origin }; }
function request(path, body, extraHeaders = {}, urlOrigin = origin) {
  return new Request(urlOrigin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': `192.0.2.${++requestNumber % 250}`, ...extraHeaders },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}
async function call(environment, suffix, body, headers) {
  return handleAuth(request('/api/auth/' + suffix, body, headers), environment);
}
function authenticator() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return {
    ...pair, id: randomBytes(32),
    cose: encodeCBOR(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])),
  };
}
function authData(counter, flags) {
  const count = Buffer.alloc(4); count.writeUInt32BE(counter);
  return Buffer.concat([hash('kuraflow.example.com'), Buffer.from([flags]), count]);
}
function registration(auth, options, extraClient = {}) {
  const credentialLength = Buffer.alloc(2); credentialLength.writeUInt16BE(auth.id.length);
  const data = Buffer.concat([authData(0, 0x45), Buffer.alloc(16), credentialLength, auth.id, auth.cose]);
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false, ...extraClient }));
  return {
    id: b64(auth.id), rawId: b64(auth.id), type: 'public-key', authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: b64(client), transports: ['internal'],
      attestationObject: b64(encodeCBOR(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', data]]))),
    },
    clientExtensionResults: { credProps: { rk: true } },
  };
}
function assertion(auth, options, userId, counter = 1, extras = {}) {
  const { flags = 0x05, ...clientExtras } = extras;
  const data = authData(counter, flags);
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false, ...clientExtras }));
  return {
    id: b64(auth.id), rawId: b64(auth.id), type: 'public-key',
    response: {
      clientDataJSON: b64(client), authenticatorData: b64(data), userHandle: b64(Buffer.from(userId)),
      signature: b64(sign('sha256', Buffer.concat([data, hash(client)]), auth.privateKey)),
    }, clientExtensionResults: {},
  };
}
async function invite(environment, options = {}) {
  return createInvite(environment.DB, { tenantId: 'tenant-a', role: 'admin', displayName: 'Admin', ...options });
}
async function register(environment, auth = authenticator(), invitation = undefined) {
  invitation ||= await invite(environment);
  const optionsResponse = await call(environment, 'register/options', { inviteToken: invitation.token });
  assert.equal(optionsResponse.status, 200);
  const options = await optionsResponse.json();
  const proof = registration(auth, options.options);
  const response = await call(environment, 'register/verify', { challengeId: options.challengeId, response: proof, role: 'store', tenantId: 'forged' });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const data = await response.json();
  return { auth, ...data, cookie: response.headers.get('Set-Cookie').split(';')[0], proof, options, invitation };
}
async function loginOptions(environment) {
  const response = await call(environment, 'login/options', {});
  assert.equal(response.status, 200);
  return response.json();
}

test('origins fail closed, reject cross-site mutations, and enforce streaming body limits', async () => {
  const environment = env();
  const missingConfig = await handleAuth(request('/api/auth/login/options', {}), { DB: environment.DB });
  assert.equal(missingConfig.status, 503);
  assert.equal((await handleAuth(request('/api/auth/login/options', {}, {}, 'https://spoof.example'), environment)).status, 403);
  assert.equal((await call(environment, 'login/options', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(environment, 'login/options', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await call(environment, 'login/options', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call(environment, 'login/options', 'x'.repeat(32769))).status, 413);
  assert.equal(environment.DB.get('SELECT count(*) AS n FROM challenges').n, 0);
  assert.equal((await handleAuth(request('/api/auth/session', undefined, {}, 'https://evil.example'), { ...environment, LOCAL_TEST: '1' })).status, 403);
  assert.equal((await handleAuth(request('/api/auth/session', undefined, {}, 'http://localhost:8787'), { DB: environment.DB, LOCAL_TEST: '1' })).status, 200);
});

test('invitations enforce tenant/store membership and never store the bearer token', async () => {
  const environment = env();
  await assert.rejects(invite(environment, { role: 'store', storeId: 'store-b' }));
  await assert.rejects(invite(environment, { role: 'admin', storeId: 'store-a' }));
  await assert.rejects(invite(environment, { role: 'owner' }));
  const token = await invite(environment, { role: 'store', storeId: 'store-a' });
  assert.match(token.token, /^[a-f0-9]{64}$/);
  assert.equal(environment.DB.get('SELECT hash FROM invites').hash, await hashToken(token.token));
  const registered = await register(environment, authenticator(), token);
  assert.equal(registered.principal.role, 'store');
  assert.equal(registered.principal.storeId, 'store-a');
  assert.equal(registered.principal.tenantId, 'tenant-a');
});

test('registration uses an invite once, hashes challenges/sessions, and issues a secure authenticated cookie', async () => {
  const environment = env();
  const registered = await register(environment);
  assert.equal(registered.principal.role, 'admin');
  const session = await call(environment, 'session', undefined, { Cookie: registered.cookie });
  assert.deepEqual((await session.json()).principal, registered.principal);
  const token = registered.cookie.split('=')[1];
  assert.equal(environment.DB.get('SELECT hash FROM sessions').hash, await hashToken(token));
  const replay = await call(environment, 'register/verify', { challengeId: registered.options.challengeId, response: registered.proof });
  assert.equal(replay.status, 401);
  assert.equal((await call(environment, 'register/options', { inviteToken: registered.invitation.token })).status, 401);
  assert.equal(environment.DB.get('SELECT count(*) AS n FROM users').n, 1);
  const next = await loginOptions(environment);
  assert.equal(environment.DB.get('SELECT challenge FROM challenges WHERE id = ?', next.challengeId).challenge, await hashToken(next.options.challenge));
  const loggedIn = await call(environment, 'login/verify', { challengeId: next.challengeId, response: assertion(registered.auth, next.options, registered.principal.userId) });
  assert.equal(loggedIn.status, 200);
  assert.match(loggedIn.headers.get('Set-Cookie'), /^__Host-kuraflow_session=[a-f0-9]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=604800$/);
});

test('real signed authentication succeeds and rejects wrong keys, origin, UV, owner, and stale counters', async () => {
  const environment = env();
  const registered = await register(environment);
  const other = authenticator();
  for (const kind of ['signature', 'origin', 'uv', 'owner', 'iframe']) {
    const next = await loginOptions(environment);
    const extra = kind === 'origin' ? { origin: 'https://evil.example' } : kind === 'uv' ? { flags: 1 } : kind === 'iframe' ? { crossOrigin: true } : {};
    const proof = assertion(registered.auth, next.options, kind === 'owner' ? 'someone-else' : registered.principal.userId, 1, extra);
    if (kind === 'signature') proof.response.signature = assertion(other, next.options, registered.principal.userId).response.signature;
    assert.equal((await call(environment, 'login/verify', { challengeId: next.challengeId, response: proof })).status, 401, kind);
  }
  const next = await loginOptions(environment);
  const proof = assertion(registered.auth, next.options, registered.principal.userId, 1);
  assert.equal((await call(environment, 'login/verify', { challengeId: next.challengeId, response: proof })).status, 200);
  assert.equal((await call(environment, 'login/verify', { challengeId: next.challengeId, response: proof })).status, 401);
  const stale = await loginOptions(environment);
  assert.equal((await call(environment, 'login/verify', { challengeId: stale.challengeId, response: assertion(registered.auth, stale.options, registered.principal.userId, 1) })).status, 401);
});

test('duplicate credentials roll back invitation redemption and challenge claim', async () => {
  const environment = env();
  const registered = await register(environment);
  const secondInvite = await invite(environment);
  const options = await (await call(environment, 'register/options', { inviteToken: secondInvite.token })).json();
  const duplicate = await call(environment, 'register/verify', { challengeId: options.challengeId, response: registration(registered.auth, options.options) });
  assert.equal(duplicate.status, 401);
  assert.equal(environment.DB.get('SELECT used_at FROM invites WHERE hash = ?', await hashToken(secondInvite.token)).used_at, null);
  assert.ok(environment.DB.get('SELECT id FROM challenges WHERE id = ?', options.challengeId));
  assert.equal(environment.DB.get('SELECT count(*) AS n FROM users').n, 1);
  const fresh = await call(environment, 'register/verify', { challengeId: options.challengeId, response: registration(authenticator(), options.options) });
  assert.equal(fresh.status, 200);
});

test('racing registrations cannot redeem the same invitation twice', async () => {
  const environment = env();
  const invitation = await invite(environment);
  const options = await Promise.all([0, 1].map(async () => (await call(environment, 'register/options', { inviteToken: invitation.token })).json()));
  const results = await Promise.all(options.map((entry) => call(environment, 'register/verify', { challengeId: entry.challengeId, response: registration(authenticator(), entry.options) })));
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 401]);
  assert.equal(environment.DB.get('SELECT count(*) AS n FROM users').n, 1);
  assert.equal(environment.DB.get('SELECT count(*) AS n FROM credentials').n, 1);
  assert.equal(environment.DB.get('SELECT count(*) AS n FROM sessions').n, 1);
});

test('concurrent credential counter updates use compare-and-swap and roll back losing sessions', async () => {
  const environment = env();
  const registered = await register(environment);
  const options = await Promise.all([loginOptions(environment), loginOptions(environment)]);
  const results = await Promise.all(options.map((entry) => call(environment, 'login/verify', {
    challengeId: entry.challengeId, response: assertion(registered.auth, entry.options, registered.principal.userId, 1),
  })));
  assert.deepEqual(results.map((response) => response.status).sort(), [200, 401]);
  assert.equal(environment.DB.get('SELECT counter FROM credentials').counter, 1);
  assert.equal(environment.DB.get('SELECT count(*) AS n FROM sessions').n, 2);
});

test('logout revokes the server session, and expired or deactivated sessions have no principal', async () => {
  const environment = env();
  const registered = await register(environment);
  const authenticatedRequest = request('/api/auth/session', undefined, { Cookie: registered.cookie });
  assert.ok(await getPrincipal(authenticatedRequest, environment));
  environment.DB.sqlite.exec('UPDATE users SET active = 0');
  assert.equal(await getPrincipal(authenticatedRequest, environment), null);
  environment.DB.sqlite.exec('UPDATE users SET active = 1; UPDATE sessions SET expires = 1');
  assert.equal(await getPrincipal(authenticatedRequest, environment), null);
  const logout = await call(environment, 'logout', {}, { Cookie: registered.cookie });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('Set-Cookie'), /Max-Age=0/);
  assert.equal(environment.DB.get('SELECT count(*) AS n FROM sessions').n, 0);
});

test('rate limits stop challenges after ten attempts per IP/minute', async () => {
  const environment = env();
  for (let i = 0; i < 10; i++) assert.equal((await call(environment, 'login/options', {}, { 'CF-Connecting-IP': '203.0.113.1' })).status, 200);
  const blocked = await call(environment, 'login/options', {}, { 'CF-Connecting-IP': '203.0.113.1' });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('Retry-After'), '60');
  assert.equal(environment.DB.get('SELECT count(*) AS n FROM challenges').n, 10);
  assert.equal((await call(environment, 'logout', {}, { 'CF-Connecting-IP': '203.0.113.1' })).status, 200);
});

test('store codes are stable, encrypted, tenant scoped and log in only as their store', async () => {
  const environment = { ...env(), STORE_CODE_KEY: randomBytes(32).toString('hex') };
  const admin = { role:'admin', tenantId:'tenant-a', userId:'owner' };
  const first = await getStoreAccessCode(environment.DB,environment,admin,'store-a');
  assert.match(first.accessCode,/^(?=.*[A-Z])(?=.*\d)[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.deepEqual(await getStoreAccessCode(environment.DB,environment,admin,'store-a'),first);
  const row=environment.DB.get('SELECT * FROM store_access_codes');
  assert.equal(row.code_hash,await hashToken(first.accessCode));
  assert.ok(!JSON.stringify(row).includes(first.accessCode));
  assert.equal(environment.DB.get('SELECT COUNT(*) AS n FROM users').n,1);
  await assert.rejects(getStoreAccessCode(environment.DB,environment,admin,'store-b'),/未找到/);
  await assert.rejects(getStoreAccessCode(environment.DB,environment,{...admin,role:'store'},'store-a'),/仅管理员/);
  const second=await getStoreAccessCode(environment.DB,environment,{...admin,tenantId:'tenant-b'},'store-b');
  assert.notEqual(first.accessCode,second.accessCode);
  const response=await call(environment,'store-code',{accessCode:first.accessCode.toLowerCase().replaceAll('-',' '),role:'admin',storeId:'store-b',tenantId:'tenant-b'});
  assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.principal.role,'store');assert.equal(result.principal.tenantId,'tenant-a');assert.equal(result.principal.storeId,'store-a');
  const cookie=response.headers.get('Set-Cookie');assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
  const session=await call(environment,'session',undefined,{Cookie:cookie.split(';')[0]});assert.equal((await session.json()).principal.storeId,'store-a');
  environment.DB.sqlite.prepare('UPDATE users SET active=0 WHERE id=?').run(row.user_id);
  assert.equal((await call(environment,'store-code',{accessCode:first.accessCode})).status,401);
  assert.equal((await call(environment,'session',undefined,{Cookie:cookie.split(';')[0]})).status,200);
  assert.equal((await (await call(environment,'session',undefined,{Cookie:cookie.split(';')[0]})).json()).authenticated,false);
});

test('store code login denies cross-site requests, wrong codes and repeated guessing', async () => {
  const environment=env();
  assert.equal((await call(environment,'store-code',{accessCode:'ABCD-1234-EFGH'},{Origin:'https://evil.example'})).status,403);
  for(let i=0;i<10;i++)assert.equal((await call(environment,'store-code',{accessCode:'ABCD-1234-EFGH'},{'CF-Connecting-IP':'198.51.100.20'})).status,401);
  const blocked=await call(environment,'store-code',{accessCode:'ABCD-1234-EFGH'},{'CF-Connecting-IP':'198.51.100.20'});
  assert.equal(blocked.status,429);assert.equal(blocked.headers.get('Retry-After'),'60');
  assert.equal(environment.DB.get('SELECT COUNT(*) AS n FROM sessions').n,0);
});

test('deleted stores cannot reuse codes, sessions or create new login invitations', async () => {
  const environment = { ...env(), STORE_CODE_KEY: randomBytes(32).toString('hex') };
  const admin = { role: 'admin', tenantId: 'tenant-a', userId: 'owner' };
  const { accessCode } = await getStoreAccessCode(environment.DB, environment, admin, 'store-a');
  const login = await call(environment, 'store-code', { accessCode });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  environment.DB.sqlite.prepare('UPDATE tenants SET core_json = ? WHERE id = ?')
    .run(JSON.stringify({ stores: [{ id: 'store-a', deletedAt: new Date().toISOString() }] }), 'tenant-a');
  assert.equal(await getPrincipal(request('/api/auth/session', undefined, { Cookie: cookie }), environment), null);
  assert.equal((await call(environment, 'store-code', { accessCode })).status, 401);
  await assert.rejects(getStoreAccessCode(environment.DB, environment, admin, 'store-a'), /未找到/);
  await assert.rejects(createInvite(environment.DB, { tenantId: 'tenant-a', storeId: 'store-a', role: 'store', displayName: '店长' }), /邀请信息/);
});

test('legacy codes upgrade once under concurrent admin reads, revoking only the old credential', async () => {
  const environment = { ...env(), STORE_CODE_KEY: randomBytes(32).toString('hex') };
  const admin = { role:'admin', tenantId:'tenant-a', userId:'owner' };
  await getStoreAccessCode(environment.DB,environment,admin,'store-a');
  const legacy = 'ABCD-1234-EFGH', encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw',Buffer.from(environment.STORE_CODE_KEY,'hex'),'AES-GCM',false,['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(JSON.stringify(['tenant-a','store-a']))},key,encoder.encode(legacy));
  environment.DB.sqlite.prepare('UPDATE store_access_codes SET code_hash=?,code_cipher=? WHERE store_id=?')
    .run(await hashToken(legacy),Buffer.concat([iv,Buffer.from(encrypted)]).toString('base64url'),'store-a');
  const login = await call(environment,'store-code',{accessCode:legacy});
  assert.equal(login.status,200);
  const cookie = login.headers.get('Set-Cookie').split(';')[0];
  const reads = await Promise.all(Array.from({length:3},()=>getStoreAccessCode(environment.DB,environment,admin,'store-a')));
  assert.equal(new Set(reads.map(row=>row.accessCode)).size,1);
  const upgraded = reads[0].accessCode;
  assert.match(upgraded,/^(?:[A-Z0-9]{4}-){3}[A-Z0-9]{4}$/);
  assert.equal((await call(environment,'store-code',{accessCode:legacy})).status,401);
  assert.equal((await call(environment,'store-code',{accessCode:upgraded.toLowerCase().replaceAll('-',' ')})).status,200);
  assert.ok(await getPrincipal(request('/api/auth/session',undefined,{Cookie:cookie}),environment));
  assert.equal(environment.DB.get('SELECT COUNT(*) AS n FROM users').n,1);
  assert.equal((await getStoreAccessCode(environment.DB,environment,admin,'store-a')).accessCode,upgraded);
});
