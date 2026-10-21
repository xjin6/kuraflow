import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { getDocumentProfile, saveDocumentProfile } from './document-profile.js';
import { hashToken } from './auth.js';
import worker from './worker.js';

const owner = { role: 'admin', accountRole: 'owner', tenantId: 'tenant-a', userId: 'owner-a' };
const store = { role: 'store', accountRole: 'owner', tenantId: 'tenant-a', userId: 'store-owner', storeId: 'store-a' };
const sealId = '11111111-1111-4111-8111-111111111111';
const otherSeal = '22222222-2222-4222-8222-222222222222';
const sealUrl = '/api/images/' + sealId;
const validIssuer = { name: '株式会社サンプル', address: '東京都千代田区 1-1', phone: '03-0000-0000', representative: '山田 太郎', sealUrl };

class D1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    const dir = new URL('./migrations/', import.meta.url);
    for (const file of readdirSync(dir).filter(file => file.endsWith('.sql')).sort()) this.sqlite.exec(readFileSync(new URL(file, dir), 'utf8'));
    this.core = { stores: [{ id: 'store-a', name: 'Store A' }, { id: 'gone', deletedAt: '2026-10-19' }], settings: { companyName: 'Configured company', currency: 'JPY', issuer: { bank: 'retained-bank' } }, prices: { 'store-a': { 'product-a': 120 } }, otherSetting: { nested: ['preserved'] } };
    this.sqlite.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').run('tenant-a', 'Tenant A', JSON.stringify(this.core));
    this.sqlite.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').run('tenant-b', 'Tenant B', '{"stores":[{"id":"store-b"}],"settings":{}}');
    this.sqlite.prepare('INSERT INTO private_materials(tenant_id,data_json) VALUES(?,?)').run('tenant-a', JSON.stringify({ company: { name: 'Original company', address: 'Original address', phone: 'original-phone', contact: 'Original contact', source: 'private-file', bank: 'private-bank' }, materialCosts: [{ cost: 'private-cost' }], token: 'private-token' }));
    for (const [id, tenantId] of [[sealId, 'tenant-a'], [otherSeal, 'tenant-b']]) this.sqlite.prepare('INSERT INTO media_files(id,tenant_id,object_key,mime,bytes,created_at) VALUES(?,?,?,?,?,?)').run(id, tenantId, tenantId + '/' + id, 'image/png', 40, '2026-10-19');
  }
  prepare(sql) {
    const sqlite = this.sqlite;
    const statement = (args = []) => ({
      bind: (...values) => statement(values),
      first: async () => sqlite.prepare(sql).get(...args) || null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => ({ success: true, meta: sqlite.prepare(sql).run(...args) }),
      sync: () => ({ success: true, meta: sqlite.prepare(sql).run(...args) }),
    });
    return statement();
  }
  async batch(statements) {
    this.beforeBatch?.();
    this.sqlite.exec('BEGIN');
    try { const result = statements.map(statement => statement.sync()); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  get(sql, ...args) { return this.sqlite.prepare(sql).get(...args); }
  saved(tenantId = 'tenant-a') { return JSON.parse(this.get('SELECT core_json FROM tenants WHERE id=?', tenantId).core_json); }
}

test('document issuer reads only approved current-tenant fields for management and store', async () => {
  const db = new D1();
  const expected = { version: 0, issuer: { name: 'Configured company', address: 'Original address', phone: 'original-phone', representative: 'Original contact' } };
  for (const principal of [owner, { ...owner, accountRole: 'member' }, store, { ...store, accountRole: 'member' }]) assert.deepEqual(await getDocumentProfile(db, principal), expected);
  assert.doesNotMatch(JSON.stringify(expected), /bank|cost|source|token|prices/);
  assert.deepEqual(await getDocumentProfile(db, { ...owner, tenantId: 'tenant-b' }), { version: 0, issuer: { name: 'Tenant B', address: '', phone: '', representative: '' } });
  db.sqlite.prepare('UPDATE tenants SET core_json=? WHERE id=?').run(JSON.stringify({ ...db.core, settings: { ...db.core.settings, issuer: { name: 'Document company', phone: '' } } }), 'tenant-a');
  assert.equal((await getDocumentProfile(db, owner)).issuer.name, 'Document company');
  assert.equal((await getDocumentProfile(db, store)).issuer.phone, '');
});

test('document profile permissions reject unauthenticated, platform, member writes, invalid and deleted stores', async () => {
  const db = new D1(), body = { version: 0, issuer: validIssuer };
  await assert.rejects(getDocumentProfile(db, null), { status: 401 });
  await assert.rejects(saveDocumentProfile(db, null, body), { status: 401 });
  await assert.rejects(getDocumentProfile(db, { role: 'platform' }), { status: 403 });
  for (const principal of [{ role: 'platform' }, store, { ...owner, accountRole: 'member' }, { ...owner, accountRole: undefined }]) await assert.rejects(saveDocumentProfile(db, principal, body), { status: 403 });
  for (const storeId of ['store-b', 'gone', undefined]) await assert.rejects(getDocumentProfile(db, { ...store, storeId }), { status: 403 });
  await assert.rejects(getDocumentProfile(db, { ...owner, tenantId: 'missing' }), { status: 404 });
  assert.equal(db.get('SELECT revision FROM tenants WHERE id=?', 'tenant-a').revision, 0);
});

test('owner saves issuer without changing company, pricing, private materials or another tenant', async () => {
  const db = new D1(), otherBefore = db.saved('tenant-b'), privateBefore = db.get('SELECT data_json FROM private_materials WHERE tenant_id=?', 'tenant-a');
  const result = await saveDocumentProfile(db, owner, { version: 0, issuer: validIssuer });
  assert.deepEqual(result, { version: 1, issuer: validIssuer });
  assert.deepEqual(await getDocumentProfile(db, store), result);
  const saved = db.saved();
  assert.deepEqual(saved, { ...db.core, settings: { ...db.core.settings, issuer: { bank: 'retained-bank', ...validIssuer } } });
  assert.deepEqual(db.saved('tenant-b'), otherBefore);
  assert.deepEqual(db.get('SELECT data_json FROM private_materials WHERE tenant_id=?', 'tenant-a'), privateBefore);
  assert.equal(db.get('SELECT name FROM tenants WHERE id=?', 'tenant-a').name, 'Tenant A');
  assert.deepEqual({ ...db.get('SELECT command,user_id,revision FROM business_audit_log') }, { command: 'updateDocumentProfile', user_id: 'owner-a', revision: 1 });
  assert.equal(db.get('SELECT count(*) AS count FROM business_write_assertion').count, 0);
});

test('issuer validates fields and never accepts arbitrary tenants, external seals or other tenant images', async () => {
  const db = new D1();
  for (const issuer of [
    null, [], { ...validIssuer, name: '' }, { ...validIssuer, name: 'x'.repeat(161) },
    { ...validIssuer, address: 'x'.repeat(401) }, { ...validIssuer, phone: 123 },
    { ...validIssuer, representative: 'x'.repeat(121) }, { ...validIssuer, phone: 'a\u0000b' },
    { ...validIssuer, token: 'secret' }, { ...validIssuer, bank: 'other-bank' },
    { ...validIssuer, sealUrl: 'https://external.example/seal.png' }, { ...validIssuer, sealUrl: 'data:image/png;base64,AA==' },
    { ...validIssuer, sealUrl: sealUrl + '?tenant=tenant-b' }, JSON.parse('{"name":"Test","__proto__":{"name":"Wrong"}}'),
  ]) await assert.rejects(saveDocumentProfile(db, owner, { version: 0, issuer }), { status: 400 });
  for (const body of [{ version: '0', issuer: validIssuer }, { version: -1, issuer: validIssuer }, { version: 0, issuer: validIssuer, tenantId: 'tenant-b' }]) await assert.rejects(saveDocumentProfile(db, owner, body), { status: 400 });
  await assert.rejects(saveDocumentProfile(db, owner, { version: 0, issuer: { ...validIssuer, sealUrl: '/api/images/' + otherSeal } }), { status: 409, code: 'DOCUMENT_SEAL_UNAVAILABLE' });
  assert.deepEqual(db.saved(), db.core);
});

test('configured missing or invalid seals fail explicitly; owner can clear them', async () => {
  const db = new D1();
  await saveDocumentProfile(db, owner, { version: 0, issuer: validIssuer });
  db.sqlite.prepare('DELETE FROM media_files WHERE id=?').run(sealId);
  await assert.rejects(getDocumentProfile(db, owner), { status: 409, code: 'DOCUMENT_SEAL_UNAVAILABLE' });
  await assert.rejects(getDocumentProfile(db, store), { status: 409, code: 'DOCUMENT_SEAL_UNAVAILABLE' });
  const { sealUrl: ignored, ...noSeal } = validIssuer;
  const cleared = await saveDocumentProfile(db, owner, { version: 1, issuer: { ...validIssuer, sealUrl: null } });
  assert.deepEqual(cleared.issuer, noSeal);
  assert.deepEqual(await getDocumentProfile(db, owner), cleared);
  assert.equal(db.saved().settings.issuer.sealUrl, null);
  db.sqlite.prepare("UPDATE tenants SET core_json=json_set(core_json,'$.settings.issuer.sealUrl',?) WHERE id=?").run('https://external.example/seal.png', 'tenant-a');
  await assert.rejects(getDocumentProfile(db, owner), { status: 409, code: 'DOCUMENT_SEAL_INVALID' });
  assert.equal((await saveDocumentProfile(db, owner, { version: 2, issuer: noSeal })).issuer.sealUrl, undefined);
});

test('stale revision and concurrent edits never overwrite other business updates or leave audit fragments', async () => {
  const db = new D1();
  const results = await Promise.allSettled(['First issuer', 'Second issuer'].map(name => saveDocumentProfile(db, owner, { version: 0, issuer: { ...validIssuer, name } })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'DOCUMENT_PROFILE_CONFLICT');
  assert.equal(db.get('SELECT revision FROM tenants WHERE id=?', 'tenant-a').revision, 1);
  assert.equal(db.get('SELECT count(*) AS count FROM business_audit_log').count, 1);
  const saved = db.saved();
  db.beforeBatch = () => {
    db.beforeBatch = null;
    db.sqlite.prepare("UPDATE tenants SET core_json=json_set(core_json,'$.otherSetting.newValue','concurrent'),revision=revision+1 WHERE id=?").run('tenant-a');
  };
  await assert.rejects(saveDocumentProfile(db, owner, { version: 1, issuer: { ...validIssuer, name: 'Stale issuer' } }), { status: 409, code: 'DOCUMENT_PROFILE_CONFLICT' });
  assert.deepEqual(db.saved().settings, saved.settings);
  assert.equal(db.saved().otherSetting.newValue, 'concurrent');
  assert.equal(db.get('SELECT revision FROM tenants WHERE id=?', 'tenant-a').revision, 2);
  assert.equal(db.get('SELECT count(*) AS count FROM business_audit_log').count, 1);
  assert.equal(db.get('SELECT count(*) AS count FROM business_write_assertion').count, 0);
});

test('image removed between validation and save cannot become the current issuer seal', async () => {
  const db = new D1();
  db.beforeBatch = () => { db.beforeBatch = null; db.sqlite.prepare('DELETE FROM media_files WHERE id=?').run(sealId); };
  await assert.rejects(saveDocumentProfile(db, owner, { version: 0, issuer: validIssuer }), { status: 409, code: 'DOCUMENT_PROFILE_CONFLICT' });
  assert.deepEqual(db.saved(), db.core);
  assert.equal(db.get('SELECT revision FROM tenants WHERE id=?', 'tenant-a').revision, 0);
  assert.equal(db.get('SELECT count(*) AS count FROM business_audit_log').count, 0);
});

test('Worker document-profile routes enforce sessions, origin, JSON size and role before saving', async () => {
  const DB = new D1(), origin = 'https://documents.example', env = { DB, PUBLIC_ORIGIN: origin, STORE_CODE_KEY: '1'.repeat(64) };
  const now = Math.floor(Date.now() / 1000);
  DB.sqlite.prepare('INSERT INTO organizations(tenant_id,code,created_at) VALUES(?,?,?)').run('tenant-a', 'test-org', now);
  const cookies = {};
  for (const [index, [label, role, accountRole]] of [['owner', 'admin', 'owner'], ['member', 'admin', 'member'], ['store', 'store', 'owner'], ['platform', 'platform', 'owner']].entries()) {
    const id = 'account-' + label, token = String(index + 1).repeat(64);
    DB.sqlite.prepare("INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,created_at) VALUES(?,?,?,?,?,?,?,?,'active',?)").run(id, id, role === 'platform' ? null : 'tenant-a', role === 'store' ? 'store-a' : null, role, accountRole, label, '', now);
    DB.sqlite.prepare('INSERT INTO account_sessions(hash,account_id,expires,version) VALUES(?,?,?,0)').run(await hashToken(token), id, now + 3600);
    cookies[label] = '__Host-kuraflow_account=' + token;
  }
  const call = (role, body, headers = {}, query = '') => worker.fetch(new Request(origin + '/api/document-profile' + query, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookies[role] || '', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), env, {});
  const body = { version: 0, issuer: validIssuer };
  assert.equal((await call('none')).status, 401);
  for (const role of ['owner', 'member', 'store']) {
    const response = await call(role, undefined, {}, '?tenant=tenant-b');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).issuer.name, 'Configured company');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal((await call('platform')).status, 403);
  for (const role of ['none', 'member', 'store', 'platform']) assert.equal((await call(role, body)).status, role === 'none' ? 401 : 403);
  for (const headers of [{ Origin: 'https://other.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await call('owner', body, headers)).status, 403);
  assert.equal((await call('owner', body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call('owner', { ...body, extra: 'x'.repeat(8500) })).status, 413);
  assert.equal((await call('owner', body)).status, 200);
  assert.deepEqual(await (await call('store')).json(), { version: 1, issuer: validIssuer });
  assert.equal((await call('owner', body)).status, 409);
});

test('D1 runtime supports issuer persistence and rolls back a stale update batch', async () => {
  const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [{
    name: 'document-profile-runtime', modules: true, script: 'export default { fetch() { return new Response("ok"); } };',
    compatibilityDate: '2026-10-08', d1Databases: { DB: 'document-profile' },
  }] }));
  try {
    const db = await runtime.getD1Database('DB');
    for (const file of ['0001_business.sql', '0003_images.sql']) await db.exec(readFileSync(new URL('./migrations/' + file, import.meta.url), 'utf8').replace(/--[^\n]*/g, '').replace(/\s+/g, ' '));
    await db.prepare('INSERT INTO tenants(id,name,core_json) VALUES(?,?,?)').bind('tenant-a', 'Kitchen A', JSON.stringify({ stores: [{ id: 'store-a' }], settings: { currency: 'JPY' } })).run();
    const { sealUrl: ignored, ...issuer } = validIssuer;
    assert.deepEqual(await saveDocumentProfile(db, owner, { version: 0, issuer }), { version: 1, issuer });
    assert.deepEqual(await getDocumentProfile(db, store), { version: 1, issuer });
    const racingDB = {
      prepare: sql => db.prepare(sql),
      async batch(statements) {
        await db.prepare("UPDATE tenants SET core_json=json_set(core_json,'$.retained',1),revision=revision+1 WHERE id=?").bind('tenant-a').run();
        return db.batch(statements);
      },
    };
    await assert.rejects(saveDocumentProfile(racingDB, owner, { version: 1, issuer: { ...issuer, name: 'Stale name' } }), { status: 409, code: 'DOCUMENT_PROFILE_CONFLICT' });
    const row = await db.prepare('SELECT core_json,revision FROM tenants WHERE id=?').bind('tenant-a').first();
    assert.equal(row.revision, 2);
    assert.equal(JSON.parse(row.core_json).retained, 1);
    assert.equal(JSON.parse(row.core_json).settings.issuer.name, issuer.name);
    assert.equal((await db.prepare('SELECT count(*) AS count FROM business_audit_log').first()).count, 1);
    assert.equal((await db.prepare('SELECT count(*) AS count FROM business_write_assertion').first()).count, 0);
  } finally { await runtime.dispose(); }
});
