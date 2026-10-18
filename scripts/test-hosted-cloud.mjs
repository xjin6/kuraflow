// Run only after deployment, while Safari shows the approved Cloudflare account.
// Credentials live in memory; all business writes belong to one temporary tenant.
// Usage: node scripts/test-hosted-cloud.mjs
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { encodeCBOR } from '@levischuck/tiny-cbor';
import { seedTenant, tokyoToday } from '../backend/repository.js';
import { apiRequest, guardDashboard, ACCOUNT, DB, ORIGIN } from './safari-bridge.mjs';

const TENANT = 'kuraflow-release-smoke';
const marker = `Release smoke ${randomUUID()}`;
const rpID = new URL(ORIGIN).hostname;
const challengeIds = new Set();
let creationAttempted = false;
class SmokeError extends Error {}
const hash = value => createHash('sha256').update(value).digest();
const b64 = value => Buffer.from(value).toString('base64url');
const check = (condition, label) => { if (!condition) throw new SmokeError(label); };

// Never log D1 responses/errors: they may contain copied private business data.
async function query(sql, params = []) {
  let result;
  try { result = await apiRequest(`/d1/database/${DB}/query`, 'POST', { sql, params }); }
  catch { throw new SmokeError('D1 dashboard request failed; inspect the current operation before retrying.'); }
  check(Array.isArray(result) && result.every(row => row.success !== false), 'D1 statement failed.');
  return result[0]?.results || [];
}

async function call(label, path, { body, cookie, status = 200 } = {}) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(ORIGIN + path, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { Origin: ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
  } catch { throw new SmokeError(`${label}: network request failed.`); }
  const data = await response.json().catch(() => null);
  console.log(`${label}: HTTP ${response.status}, ${Math.round(performance.now() - started)} ms`);
  check(response.status === status, `${label}: unexpected HTTP status ${response.status}.`);
  check(data && typeof data === 'object', `${label}: expected JSON.`);
  return { data, headers: response.headers };
}

function authenticator() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = pair.publicKey.export({ format: 'jwk' });
  return { ...pair, id: randomBytes(32), cose: encodeCBOR(new Map([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')],
  ])) };
}
function authData(counter, flags) {
  const count = Buffer.alloc(4); count.writeUInt32BE(counter);
  return Buffer.concat([hash(rpID), Buffer.from([flags]), count]);
}
function registration(auth, options) {
  const length = Buffer.alloc(2); length.writeUInt16BE(auth.id.length);
  const data = Buffer.concat([authData(0, 0x45), Buffer.alloc(16), length, auth.id, auth.cose]);
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
  return {
    id: b64(auth.id), rawId: b64(auth.id), type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: b64(client), transports: ['internal'], attestationObject: b64(encodeCBOR(new Map([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', data],
    ]))) }, clientExtensionResults: { credProps: { rk: true } },
  };
}
function assertion(auth, options, userId) {
  const data = authData(1, 0x05);
  const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
  return { id: b64(auth.id), rawId: b64(auth.id), type: 'public-key', response: {
    clientDataJSON: b64(client), authenticatorData: b64(data), userHandle: b64(Buffer.from(userId)),
    signature: b64(sign('sha256', Buffer.concat([data, hash(client)]), auth.privateKey)),
  }, clientExtensionResults: {} };
}
function sessionCookie(headers) {
  const value = headers.get('set-cookie') || '';
  check(/^__Host-kuraflow_session=[a-f0-9]{64};/.test(value) && /HttpOnly/.test(value) && /Secure/.test(value) && /SameSite=Strict/.test(value), 'Session cookie protections missing.');
  return value.split(';')[0];
}
async function enrollAndLogin(role, inviteToken, storeId = null) {
  const auth = authenticator();
  const registrationOptions = (await call(`${role} registration options`, '/api/auth/register/options', { body: { inviteToken } })).data;
  challengeIds.add(registrationOptions.challengeId);
  check(registrationOptions.options.rp.id === rpID, 'Registration RP mismatch.');
  const registered = await call(`${role} registration`, '/api/auth/register/verify', {
    body: { challengeId: registrationOptions.challengeId, response: registration(auth, registrationOptions.options) },
  });
  const principal = registered.data.principal;
  check(principal?.tenantId === TENANT && principal.role === role && principal.storeId === storeId, 'Unexpected registered principal.');
  const cookie = sessionCookie(registered.headers);
  const options = (await call(`${role} login options`, '/api/auth/login/options', { body: {} })).data;
  challengeIds.add(options.challengeId);
  check(options.options.rpId === rpID, 'Login RP mismatch.');
  const loggedIn = await call(`${role} signed login`, '/api/auth/login/verify', {
    cookie, body: { challengeId: options.challengeId, response: assertion(auth, options.options, principal.userId) },
  });
  check(loggedIn.data.principal?.userId === principal.userId && loggedIn.data.principal.tenantId === TENANT, 'Login principal mismatch.');
  return sessionCookie(loggedIn.headers);
}
function command(type, args, extra = {}) { return { type, args, idempotencyKey: randomUUID(), ...extra }; }
async function mutate(label, cookie, type, args) {
  return (await call(label, '/api/commands', { cookie, body: command(type, args) })).data;
}

async function cleanup() {
  if (!creationAttempted) return;
  const rows = await query('SELECT name FROM tenants WHERE id = ?', [TENANT]);
  if (!rows.length) return;
  check(rows[0].name === marker, 'Cleanup refused: temporary tenant ownership changed.');
  // Failed registration challenges may reserve users that do not yet exist.
  await query(`DELETE FROM challenges WHERE invite_hash IN (SELECT hash FROM invites WHERE tenant_id = ?)
    OR user_id IN (SELECT id FROM users WHERE tenant_id = ?)`, [TENANT, TENANT]);
  // Login challenges have no tenant/user until consumed, so use only IDs received here.
  for (const id of challengeIds) await query('DELETE FROM challenges WHERE id = ?', [id]);
  await query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)', [TENANT]);
  await query('DELETE FROM credentials WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)', [TENANT]);
  for (const table of ['invites', 'users', 'command_idempotency', 'business_audit_log', 'orders', 'documents', 'products', 'private_materials', 'media_files', 'media_usage']) {
    await query(`DELETE FROM ${table} WHERE tenant_id = ?`, [TENANT]);
  }
  await query('DELETE FROM tenants WHERE id = ? AND name = ?', [TENANT, marker]);
  const remaining = await query('SELECT COUNT(*) AS n FROM tenants WHERE id = ?', [TENANT]);
  check(remaining[0]?.n === 0, 'Temporary tenant cleanup incomplete.');
  console.log('Temporary tenant cleanup: PASS');
  // Shared auth rate buckets expire naturally. Global atomic guards are not tenant data.
}

async function main() {
  check(TENANT !== 'maido-kitchen' && ACCOUNT === '416d8e8c519ddc0a60ead4fc98a2ae14', 'Approved target mismatch.');
  guardDashboard();
  const source = JSON.parse(await readFile(new URL('../private-deploy/seed-state.json', import.meta.url), 'utf8'));
  const state = structuredClone(source.state);
  check(state.products.length > 0 && state.stores.length >= 2, 'Realistic seed is missing.');
  state.orders = []; state.reminders = []; state.cart = {}; state.cartUnits = {};
  state.settings = { ...state.settings, companyName: marker };
  state.privateMaterials = { ...state.privateMaterials, smokeMarker: marker };
  const storeId = state.stores[0].id, otherStoreId = state.stores[1].id;
  const statements = [];
  await seedTenant({
    prepare(sql) { return { bind: (...params) => ({ sql, params }) }; },
    async batch(values) { statements.push(...values); return []; },
  }, { tenantId: TENANT, state, companyName: marker });
  check(statements.every(value => value.params[0] === TENANT), 'Seed statement scope mismatch.');
  check((await query('SELECT id FROM tenants WHERE id = ?', [TENANT])).length === 0, 'Temporary tenant already exists; refusing to replace it.');

  await call('health', '/api/health');
  await call('anonymous state denied', '/api/state', { status: 401 });
  creationAttempted = true;
  try {
    for (const statement of statements) await query(statement.sql, statement.params);
    console.log('Realistic temporary seed: PASS');
    const inviteToken = randomBytes(32).toString('hex');
    await query('INSERT INTO invites(hash, tenant_id, store_id, role, display_name, expires) VALUES (?, ?, NULL, ?, ?, ?)',
      [hash(inviteToken).toString('hex'), TENANT, 'admin', 'Release smoke admin', Math.floor(Date.now() / 1000) + 1800]);
    const admin = await enrollAndLogin('admin', inviteToken);
    const adminState = (await call('admin full state', '/api/state', { cookie: admin })).data;
    check(adminState.state.products.length === state.products.length && adminState.state.stores.length === state.stores.length, 'Admin seed load mismatch.');
    const materials = (await call('admin private materials', '/api/admin/materials', { cookie: admin })).data;
    check(materials.smokeMarker === marker, 'Private materials scope mismatch.');
    const invitation = (await call('store invitation', '/api/admin/invites', { cookie: admin, body: { storeId, displayName: 'Release smoke store' }, status: 201 })).data;
    const inviteUrl = new URL(invitation.url);
    check(inviteUrl.origin === ORIGIN && /^#invite=[a-f0-9]{64}$/.test(inviteUrl.hash), 'Store invitation origin mismatch.');
    let store = await enrollAndLogin('store', inviteUrl.hash.slice('#invite='.length), storeId);
    const code = (await call('admin store code', '/api/admin/store-code', {cookie:admin,body:{storeId}})).data;
    check(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code.accessCode),'Store code format mismatch.');
    const codeLogin = await call('store code login', '/api/auth/store-code', {body:{accessCode:code.accessCode.toLowerCase()}});
    check(codeLogin.data.principal?.tenantId===TENANT && codeLogin.data.principal?.storeId===storeId && codeLogin.data.principal?.role==='store','Code scope mismatch.');
    store = sessionCookie(codeLogin.headers);
    await call('store code management denied','/api/admin/store-code',{cookie:store,body:{storeId},status:403});
    await call('store private materials denied', '/api/admin/materials', { cookie: store, status: 403 });

    const added = await mutate('add product', admin, 'addProduct', [{ name: 'Release smoke product', category: '冷冻品', unit: '箱', spec: '15KG/箱', stock: 10, basePrice: 1500 }]);
    const pid = added.result.id;
    await mutate('set unit equations', admin, 'setSaleUnitEquations', [pid, [{fromQty:30,fromUnit:'KG',toQty:2,toUnit:'箱'}]]);
    await mutate('set KG quote', admin, 'setUnitQuote', [storeId, pid, 'KG', 120, 'exclusive', 0.08]);
    await mutate('allocate KG stock', admin, 'setStoreUnitAllocation', [storeId, pid, 'KG', 30]);
    await mutate('count stock in KG', admin, 'setWarehouseUnitStock', [pid, 'KG', 165]);
    const updated = (await call('admin reload', '/api/state', { cookie: admin })).data;
    check(updated.state.inventory[pid] === 11, 'Warehouse update did not persist.');
    const scoped = (await call('store isolated state', '/api/state', { cookie: store })).data.state;
    check(scoped.stores.length === 1 && scoped.stores[0].id === storeId, 'Store list isolation failed.');
    for (const field of ['prices', 'quoteMeta', 'unitQuotes']) check(Object.keys(scoped[field]).every(id => id === storeId), 'Store quote isolation failed.');
    check(scoped.documents.every(row => row.storeId === storeId) && scoped.orders.every(row => row.storeId === storeId), 'Store document/order isolation failed.');
    check(!scoped.privateMaterials && Object.keys(scoped.storeAllocations).length === 0, 'Private state exposure.');
    check(scoped.products.every(row => row.basePrice === null && row.source === undefined && row.referencePrice === undefined && row.costReferences === undefined), 'Private product field exposure.');
    check(scoped.inventory[pid] === 2 && scoped.unitQuotes[storeId][pid].KG.price === 120, 'Store allocation/quote mismatch.');
    await call('store management denied', '/api/commands', { cookie: store, body: command('setWarehouseStock', [pid, 99]), status: 403 });
    await call('cross-store ordering denied', '/api/commands', { cookie: store, body: command('submitOrder', [otherStoreId, { [pid]: 1 }, tokyoToday()]), status: 403 });

    const orderCommand = command('submitOrder', [storeId, { [pid]: 7.5 }, tokyoToday(), 'Release smoke', { [pid]: 'KG' }], {
      expectedQuotes: { [pid]: { price: 120, taxBasis: 'exclusive', taxRate: 0.08, unit: 'KG', perBase: 15 } },
    });
    // Two concurrent requests represent a network retry, exercising CAS/idempotency.
    const outcomes = await Promise.allSettled([1, 2].map(index => call(`concurrent order ${index}`, '/api/commands', { cookie: store, body: orderCommand })));
    check(outcomes.every(value => value.status === 'fulfilled'), 'Concurrent order request failed.');
    const orders = outcomes.map(value => value.value.data);
    check(new Set(orders.map(row => row.result.id)).size === 1 && orders.filter(row => row.replayed).length === 1, 'Concurrent retry created duplicate work.');
    check(orders.every(row => row.result.items[0].baseQty === 0.5 && row.result.items[0].price === 120), 'Unit conversion or authoritative quote mismatch.');
    const finalAdmin = (await call('persisted admin order reload', '/api/state', { cookie: admin })).data.state;
    const finalStore = (await call('persisted store order reload', '/api/state', { cookie: store })).data.state;
    check(finalAdmin.orders.length === 1 && finalStore.orders.length === 1 && finalAdmin.inventory[pid] === 10.5 && finalAdmin.storeAllocations[storeId][pid] === 1.5 && finalStore.inventory[pid] === 1.5, 'Persisted order/stock mismatch.');
    await call('store product deletion denied', '/api/commands', { cookie: store, body: command('deleteProduct', [pid]), status: 403 });
    await call('store product restoration denied', '/api/commands', { cookie: store, body: command('restoreProduct', [pid]), status: 403 });
    const deleteCommand = command('deleteProduct', [pid]);
    const deleted = (await call('delete product into recycle bin', '/api/commands', { cookie: admin, body: deleteCommand })).data;
    check(!!deleted.result.deletedAt, 'Deleted product marker missing.');
    const deletedAgain = (await call('replay product deletion', '/api/commands', { cookie: admin, body: deleteCommand })).data;
    check(deletedAgain.replayed && deletedAgain.revision === deleted.revision, 'Deletion retry was not idempotent.');
    const recycledStore = (await call('deleted product store reload', '/api/state', { cookie: store })).data.state;
    check(recycledStore.products.find(product => product.id === pid)?.deletedAt === deleted.result.deletedAt && recycledStore.inventory[pid] === 0, 'Deleted product remains orderable.');
    check(recycledStore.orders.length === 1 && recycledStore.products.find(product => product.id === pid)?.name === 'Release smoke product', 'Historical order product details were lost.');
    await call('deleted product order denied', '/api/commands', { cookie: store, body: { ...orderCommand, idempotencyKey: randomUUID() }, status: 400 });
    const oid = orders[0].result.id;
    await mutate('pack deleted product order', admin, 'packLine', [oid, pid, 7.5]);
    await mutate('confirm packed product order', admin, 'confirmPackLine', [oid, pid]);
    await mutate('ready deleted product order', admin, 'setStage', [oid, 'ready']);
    await mutate('deliver deleted product order', admin, 'setStage', [oid, 'delivering']);
    await mutate('confirm deleted product delivery', store, 'confirmDelivery', [oid, 'Release smoke receiver']);
    const restored = await mutate('restore recycled product', admin, 'restoreProduct', [pid]);
    const originalProduct = finalAdmin.products.find(product => product.id === pid);
    check(!restored.result.deletedAt && JSON.stringify(restored.result) === JSON.stringify(originalProduct), 'Restored product metadata or units changed.');
    check(restored.state.inventory[pid] === 10.5 && restored.state.storeAllocations[storeId][pid] === 1.5 && restored.state.unitQuotes[storeId][pid].KG.price === 120, 'Restored product stock or quotes changed.');
    const restoredStore = (await call('restored product store reload', '/api/state', { cookie: store })).data.state;
    check(!restoredStore.products.find(product => product.id === pid)?.deletedAt && restoredStore.inventory[pid] === 1.5 && restoredStore.orders[0].stage === 'delivered', 'Restored product or completed history did not persist.');
    const created = await mutate('create store with code',admin,'addStore',[{name:'Release smoke address',prefectureCode:'27',municipalityCode:'27100',wardCode:'27111',addressDetail:'難波中1丁目2番3号',contact:'Smoke',phone:'090-1234-5678'}]);
    check(created.result.address==='大阪府大阪市浪速区難波中1丁目2番3号' && /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(created.result.accessCode),'New store provisioning mismatch.');
    const recovered=(await call('recover same store code','/api/admin/store-code',{cookie:admin,body:{storeId:created.result.id}})).data;
    check(recovered.accessCode===created.result.accessCode,'Stored code changed unexpectedly.');
    console.log('Hosted code login, address creation, unit equations, stock, recycling, historical delivery, isolation and CAS replay: PASS');
  } finally { await cleanup(); }
}

try { await main(); }
catch (error) {
  // Errors above are fixed labels; never print raw API objects or cryptographic material.
  console.error(error instanceof SmokeError ? error.message : 'Hosted smoke failed during local preparation or dashboard access.');
  process.exitCode = 1;
}
