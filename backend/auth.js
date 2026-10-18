import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';

const SESSION_COOKIE = '__Host-kuraflow_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const CHALLENGE_SECONDS = 5 * 60;
const BODY_LIMIT = 32 * 1024;
const HEX_TOKEN = /^[a-f0-9]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card']);
const encoder = new TextEncoder();

class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const seconds = () => Math.floor(Date.now() / 1000);
const rejected = () => new AuthError(401, 'AUTH_FAILED', '验证未完成或已过期，请重新尝试。');

function json(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

export async function hashToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64(value) {
  if (typeof value !== 'string' || !BASE64URL.test(value)) throw rejected();
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0));
}

/** Host, origin, and RP ID come from a pinned deployment origin, never proxy headers. */
function deployment(request, env) {
  const url = new URL(request.url);
  if (env.LOCAL_TEST === '1' && ['localhost','127.0.0.1'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) {
    return { origin: url.origin, rpID: 'localhost', local: true };
  }
  let configured;
  try { configured = new URL(env.PUBLIC_ORIGIN); } catch { /* handled below */ }
  if (!configured || configured.protocol !== 'https:' || configured.origin !== env.PUBLIC_ORIGIN) {
    throw new AuthError(503, 'AUTH_NOT_CONFIGURED', '登录服务尚未配置完成。');
  }
  if (url.origin !== configured.origin) {
    throw new AuthError(403, 'ORIGIN_REJECTED', '请从正式网站访问。');
  }
  return { origin: configured.origin, rpID: configured.hostname, local: false };
}

/** All state-changing auth endpoints reject cross-site requests before any DB work. */
async function readMutation(request, origin) {
  if (request.headers.get('Origin') !== origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new AuthError(403, 'ORIGIN_REJECTED', '请求来源不正确，请刷新后重试。');
  }
  if ((request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new AuthError(415, 'JSON_REQUIRED', '请求必须使用 JSON 格式。');
  }
  if (Number(request.headers.get('Content-Length') || 0) > BODY_LIMIT) {
    throw new AuthError(413, 'BODY_TOO_LARGE', '请求内容过大。');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError(400, 'INVALID_JSON', '请求内容不正确。');
  let length = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        throw new AuthError(413, 'BODY_TOO_LARGE', '请求内容过大。');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let body;
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch {
    throw new AuthError(400, 'INVALID_JSON', '请求内容不正确。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AuthError(400, 'INVALID_JSON', '请求内容不正确。');
  }
  return body;
}

function sessionToken(request) {
  const values = (request.headers.get('Cookie') || '').split(';')
    .map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
  if (values.length !== 1) return null;
  const token = values[0].slice(SESSION_COOKIE.length + 1);
  return HEX_TOKEN.test(token) ? token : null;
}

function cookie(token, maxAge = SESSION_SECONDS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function principal(row) {
  return { tenantId: row.tenant_id, userId: row.id, role: row.role, storeId: row.store_id, displayName: row.display_name };
}

export async function getPrincipal(request, env) {
  deployment(request, env);
  const token = sessionToken(request);
  if (!token) return null;
  const row = await env.DB.prepare(`
    SELECT u.id, u.tenant_id, u.role, u.store_id, u.display_name
    FROM sessions s JOIN users u ON u.id = s.user_id JOIN tenants t ON t.id = u.tenant_id
    WHERE s.hash = ? AND s.expires > ? AND u.active = 1
      AND (u.role = 'admin' OR EXISTS (SELECT 1 FROM json_each(t.core_json, '$.stores')
        WHERE json_extract(value, '$.id') = u.store_id AND json_extract(value, '$.deletedAt') IS NULL))
  `).bind(await hashToken(token), seconds()).first();
  return row ? principal(row) : null;
}

function assertChanged(db) {
  return db.prepare(`INSERT INTO auth_atomic_guard(id, ok)
    VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
    ON CONFLICT(id) DO UPDATE SET ok = excluded.ok`);
}

async function rateLimit(request, env, local) {
  // Cloudflare supplies this header at its edge. Local requests share a test bucket.
  const ip = (request.headers.get('CF-Connecting-IP') || (local ? 'local' : 'unknown')).slice(0, 64);
  const now = seconds();
  const window = Math.floor(now / 60);
  const bucket = await hashToken(`kuraflow-auth:${ip}:${window}`);
  const row = await env.DB.prepare(`INSERT INTO auth_rate_limits(bucket, attempts, expires) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = min(attempts + 1, 11) RETURNING attempts`)
    .bind(bucket, (window + 2) * 60).first();
  if (!row || row.attempts > 10) throw new AuthError(429, 'RATE_LIMITED', '尝试次数较多，请一分钟后重试。');
  // Indexed, bounded cleanup keeps expired authentication records from accumulating.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_rate_limits WHERE bucket IN (SELECT bucket FROM auth_rate_limits WHERE expires <= ? LIMIT 100)').bind(now),
    env.DB.prepare('DELETE FROM challenges WHERE id IN (SELECT id FROM challenges WHERE expires <= ? LIMIT 100)').bind(now),
    env.DB.prepare('DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE expires <= ? LIMIT 100)').bind(now),
    env.DB.prepare('DELETE FROM invites WHERE hash IN (SELECT hash FROM invites WHERE expires <= ? LIMIT 100)').bind(now - SESSION_SECONDS),
  ]);
}

export async function createInvite(db, { tenantId, storeId = null, role, displayName, expiresInSeconds = 86400 }) {
  if (!['admin', 'store'].includes(role) || typeof tenantId !== 'string' || !tenantId ||
      typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 80 ||
      !Number.isInteger(expiresInSeconds) || expiresInSeconds < 60 || expiresInSeconds > 7 * 86400 ||
      (role === 'admin' && storeId !== null) || (role === 'store' && (typeof storeId !== 'string' || !storeId))) {
    throw new AuthError(400, 'INVALID_INVITE', '邀请信息不正确。');
  }
  const tenant = await db.prepare('SELECT core_json FROM tenants WHERE id = ?').bind(tenantId).first();
  if (!tenant) throw new AuthError(400, 'INVALID_INVITE', '邀请信息不正确。');
  if (role === 'store') {
    const core = JSON.parse(tenant.core_json);
    if (!Array.isArray(core.stores) || !core.stores.some((store) => store.id === storeId && !store.deletedAt)) {
      throw new AuthError(400, 'INVALID_INVITE', '邀请信息不正确。');
    }
  }
  const token = randomToken();
  const expires = seconds() + expiresInSeconds;
  await db.prepare('INSERT INTO invites(hash, tenant_id, store_id, role, display_name, expires) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await hashToken(token), tenantId, storeId, role, displayName.trim(), expires).run();
  return { token, expiresAt: new Date(expires * 1000).toISOString() };
}

async function saveChallenge(db, options, type, { userId = null, inviteHash = null } = {}) {
  const id = randomToken();
  await db.prepare('INSERT INTO challenges(id, user_id, challenge, type, invite_hash, expires) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, await hashToken(options.challenge), type, inviteHash, seconds() + CHALLENGE_SECONDS).run();
  return json({ challengeId: id, options });
}

async function challengeFor(db, body, type) {
  if (typeof body.challengeId !== 'string' || !HEX_TOKEN.test(body.challengeId)) throw rejected();
  const challenge = await db.prepare('SELECT * FROM challenges WHERE id = ? AND type = ? AND expires > ?')
    .bind(body.challengeId, type, seconds()).first();
  if (!challenge) throw rejected();
  const response = body.response;
  if (!response || typeof response !== 'object' || response.type !== 'public-key' ||
      typeof response.id !== 'string' || response.id.length > 2048 || !BASE64URL.test(response.id) ||
      typeof response.response?.clientDataJSON !== 'string' || response.response.clientDataJSON.length > 12000) throw rejected();
  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fromBase64(response.response.clientDataJSON)));
    if (data.crossOrigin === true || data.topOrigin !== undefined) throw rejected();
  } catch { throw rejected(); }
  return challenge;
}

async function registerOptions(db, body, config) {
  if (typeof body.inviteToken !== 'string' || !HEX_TOKEN.test(body.inviteToken)) throw rejected();
  const inviteHash = await hashToken(body.inviteToken);
  const invite = await db.prepare('SELECT * FROM invites WHERE hash = ? AND used_at IS NULL AND expires > ?')
    .bind(inviteHash, seconds()).first();
  if (!invite) throw rejected();
  const userId = crypto.randomUUID();
  const options = await generateRegistrationOptions({
    rpName: '倉流 KURAFLOW', rpID: config.rpID,
    userName: invite.display_name, userDisplayName: invite.display_name,
    userID: encoder.encode(userId),
    attestationType: 'none', timeout: 120000,
    supportedAlgorithmIDs: [-7, -257],
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  });
  return saveChallenge(db, options, 'register', { userId, inviteHash });
}

async function newSession(db, userId, request) {
  const token = randomToken();
  const statements = [];
  const previous = sessionToken(request);
  if (previous) statements.push(db.prepare('DELETE FROM sessions WHERE hash = ?').bind(await hashToken(previous)));
  // Limit a user's live sessions while keeping recent devices signed in.
  statements.push(db.prepare(`DELETE FROM sessions WHERE user_id = ? AND hash NOT IN
    (SELECT hash FROM sessions WHERE user_id = ? ORDER BY expires DESC LIMIT 9)`).bind(userId, userId));
  statements.push(db.prepare('INSERT INTO sessions(hash, user_id, expires) VALUES (?, ?, ?)')
    .bind(await hashToken(token), userId, seconds() + SESSION_SECONDS));
  return { token, statements };
}

async function registerVerify(request, db, body, config) {
  const challenge = await challengeFor(db, body, 'register');
  const invite = await db.prepare('SELECT * FROM invites WHERE hash = ? AND used_at IS NULL AND expires > ?')
    .bind(challenge.invite_hash, seconds()).first();
  if (!invite) throw rejected();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: async (value) => await hashToken(value) === challenge.challenge,
      expectedOrigin: config.origin, expectedRPID: config.rpID,
      requireUserVerification: true, requireUserPresence: true, supportedAlgorithmIDs: [-7, -257],
    });
  } catch { throw rejected(); }
  if (!verification.verified || !verification.registrationInfo?.userVerified) throw rejected();
  const credential = verification.registrationInfo.credential;
  const transports = (Array.isArray(credential.transports) ? credential.transports : [])
    .filter((value) => TRANSPORTS.has(value)).slice(0, 6);
  const session = await newSession(db, challenge.user_id, request);
  const now = seconds();
  try {
    // D1 batches are transactions. CHECK failures roll back invite, challenge,
    // user, credential and session together if another request won the race.
    await db.batch([
      db.prepare('DELETE FROM challenges WHERE id = ? AND type = ? AND expires > ?')
        .bind(challenge.id, 'register', now), assertChanged(db),
      db.prepare('UPDATE invites SET used_at = ? WHERE hash = ? AND used_at IS NULL AND expires > ?')
        .bind(now, invite.hash, now), assertChanged(db),
      db.prepare('INSERT INTO users(id, tenant_id, role, store_id, display_name, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
        .bind(challenge.user_id, invite.tenant_id, invite.role, invite.store_id, invite.display_name, now),
      db.prepare('INSERT INTO credentials(id, user_id, public_key, counter, transports) VALUES (?, ?, ?, ?, ?)')
        .bind(credential.id, challenge.user_id, toBase64(credential.publicKey), credential.counter, JSON.stringify(transports)),
      ...session.statements,
    ]);
  } catch { throw rejected(); }
  return json({ principal: principal({ id: challenge.user_id, ...invite }) }, 200, { 'Set-Cookie': cookie(session.token) });
}

async function loginVerify(request, db, body, config) {
  const challenge = await challengeFor(db, body, 'login');
  const credential = await db.prepare(`SELECT c.*, u.tenant_id, u.role, u.store_id, u.display_name
    FROM credentials c JOIN users u ON u.id = c.user_id WHERE c.id = ? AND u.active = 1`)
    .bind(body.response.id).first();
  if (!credential) throw rejected();
  // These are discoverable credentials: the authenticator must identify its owner.
  if (body.response.response.userHandle !== toBase64(encoder.encode(credential.user_id))) throw rejected();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response,
      expectedChallenge: async (value) => await hashToken(value) === challenge.challenge,
      expectedOrigin: config.origin, expectedRPID: config.rpID,
      credential: { id: credential.id, publicKey: fromBase64(credential.public_key), counter: credential.counter },
      requireUserVerification: true,
    });
  } catch { throw rejected(); }
  if (!verification.verified || !verification.authenticationInfo.userVerified) throw rejected();
  const session = await newSession(db, credential.user_id, request);
  try {
    await db.batch([
      db.prepare('DELETE FROM challenges WHERE id = ? AND type = ? AND expires > ?')
        .bind(challenge.id, 'login', seconds()), assertChanged(db),
      db.prepare(`UPDATE credentials SET counter = ? WHERE id = ? AND counter = ?
        AND EXISTS (SELECT 1 FROM users WHERE id = credentials.user_id AND active = 1)`)
        .bind(verification.authenticationInfo.newCounter, credential.id, credential.counter), assertChanged(db),
      ...session.statements,
    ]);
  } catch { throw rejected(); }
  return json({ principal: principal({ ...credential, id: credential.user_id }) }, 200, { 'Set-Cookie': cookie(session.token) });
}

function normalizeStoreCode(raw) {
  if (typeof raw !== 'string' || raw.length > 64) return '';
  const value = raw.toUpperCase().replace(/[\s-]/g, '');
  // Existing credentials remain usable until the admin retrieves their upgrade.
  return /^(?=.*[A-Z])(?=.*\d)(?:[A-Z0-9]{12}|[A-Z0-9]{16})$/.test(value) ? value.match(/.{4}/g).join('-') : '';
}

function generateStoreCode() {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  for (;;) {
    let raw = '';
    while (raw.length < 16) {
      for (const byte of crypto.getRandomValues(new Uint8Array(20))) {
        if (byte < 252 && raw.length < 16) raw += alphabet[byte % 36];
      }
    }
    const code = normalizeStoreCode(raw);
    if (code) return code;
  }
}

async function storeCodeKey(env) {
  if (!/^[a-f0-9]{64}$/.test(env.STORE_CODE_KEY || '')) throw new AuthError(503, 'CODE_NOT_CONFIGURED', '门店识别码服务尚未配置。');
  const bytes = Uint8Array.from(env.STORE_CODE_KEY.match(/../g), value => parseInt(value, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function getStoreAccessCode(db, env, current, storeId) {
  if (current?.role !== 'admin') throw new AuthError(403, 'FORBIDDEN', '仅管理员可管理门店识别码。');
  if (typeof storeId !== 'string' || storeId.length > 160) throw new AuthError(400, 'INVALID_STORE', '门店信息不正确。');
  const tenant = await db.prepare('SELECT core_json FROM tenants WHERE id = ?').bind(current.tenantId).first();
  const store = tenant && JSON.parse(tenant.core_json).stores?.find(s => s.id === storeId);
  if (!store || store.deletedAt) throw new AuthError(404, 'STORE_NOT_FOUND', '未找到门店。');
  const key = await storeCodeKey(env), additionalData = encoder.encode(JSON.stringify([current.tenantId, storeId]));
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.prepare('SELECT c.code_cipher, c.code_hash, u.active FROM store_access_codes c JOIN users u ON u.id = c.user_id WHERE c.tenant_id = ? AND c.store_id = ?')
      .bind(current.tenantId, storeId).first();
    if (existing) {
      if (!existing.active) throw new AuthError(403, 'STORE_DISABLED', '此门店登录已停用。');
      const bytes = fromBase64(existing.code_cipher);
      const decoded = await crypto.subtle.decrypt({ name:'AES-GCM', iv:bytes.slice(0,12), additionalData }, key, bytes.slice(12));
      const accessCode = new TextDecoder().decode(decoded);
      if (accessCode.replaceAll('-', '').length === 16) return { storeId, accessCode };
    }
    const accessCode = generateStoreCode(), userId = crypto.randomUUID(), iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv, additionalData }, key, encoder.encode(accessCode)));
    const bytes = new Uint8Array(iv.length + encrypted.length); bytes.set(iv); bytes.set(encrypted,iv.length);
    try {
      if (existing) {
        // Compare-and-swap makes concurrent reads return one stable new code.
        // Keep the user and sessions; the replaced hash revokes only the old code.
        const updated = await db.prepare(`UPDATE store_access_codes SET code_hash = ?, code_cipher = ?
          WHERE tenant_id = ? AND store_id = ? AND code_hash = ?
            AND EXISTS (SELECT 1 FROM users WHERE id = store_access_codes.user_id AND active = 1)`)
          .bind(await hashToken(accessCode),toBase64(bytes),current.tenantId,storeId,existing.code_hash).run();
        if (updated.meta.changes) return { storeId, accessCode };
        continue;
      }
      await db.batch([
        db.prepare("INSERT INTO users(id, tenant_id, role, store_id, display_name, active, created_at) VALUES (?, ?, 'store', ?, ?, 1, ?)")
          .bind(userId,current.tenantId,storeId,store.contact || store.name || '门店采购员',seconds()),
        db.prepare('INSERT INTO store_access_codes(tenant_id, store_id, user_id, code_hash, code_cipher, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(current.tenantId,storeId,userId,await hashToken(accessCode),toBase64(bytes),seconds()),
      ]);
      return { storeId, accessCode };
    } catch (error) {
      // Another request can create this store's code first; the transaction
      // rolls back its extra user, then the retry returns the same stored code.
      if (!/UNIQUE constraint failed/.test(String(error.message))) throw error;
    }
  }
  throw new AuthError(503, 'CODE_UNAVAILABLE', '识别码暂时无法生成，请稍后重试。');
}

async function storeCodeLogin(request, db, body) {
  const accessCode = normalizeStoreCode(body.accessCode);
  const invalid = () => new AuthError(401, 'INVALID_STORE_CODE', '识别码不正确或已停用，请核对后重试。');
  if (!accessCode) throw invalid();
  const row = await db.prepare(`SELECT u.id, u.tenant_id, u.role, u.store_id, u.display_name
    FROM store_access_codes c JOIN users u ON u.id = c.user_id JOIN tenants t ON t.id = u.tenant_id
    WHERE c.code_hash = ? AND u.active = 1 AND u.role = 'store'
      AND c.tenant_id = u.tenant_id AND c.store_id = u.store_id
      AND EXISTS (SELECT 1 FROM json_each(t.core_json, '$.stores') WHERE json_extract(value, '$.id') = u.store_id
        AND json_extract(value, '$.deletedAt') IS NULL)`)
    .bind(await hashToken(accessCode)).first();
  if (!row) throw invalid();
  const session = await newSession(db,row.id,request);
  await db.batch(session.statements);
  return json({ principal:principal(row) },200,{ 'Set-Cookie':cookie(session.token) });
}

export async function handleAuth(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/auth/')) return null;
  try {
    const config = deployment(request, env);
    if (path === '/api/auth/session' && request.method === 'GET') {
      const current = await getPrincipal(request, env);
      return json({ authenticated: !!current, principal: current });
    }
    const routes = ['/api/auth/login/options', '/api/auth/login/verify', '/api/auth/register/options', '/api/auth/register/verify', '/api/auth/logout', '/api/auth/store-code'];
    if (!routes.includes(path)) return json({ error: '接口不存在。', code: 'NOT_FOUND' }, 404);
    if (request.method !== 'POST') return json({ error: '请求方式不正确。', code: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST' });
    const body = await readMutation(request, config.origin);
    if (path === '/api/auth/logout') {
      const token = sessionToken(request);
      if (token) await env.DB.prepare('DELETE FROM sessions WHERE hash = ?').bind(await hashToken(token)).run();
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    }
    await rateLimit(request, env, config.local);
    if (path === '/api/auth/store-code') return await storeCodeLogin(request,env.DB,body);
    if (path === '/api/auth/register/options') return await registerOptions(env.DB, body, config);
    if (path === '/api/auth/register/verify') return await registerVerify(request, env.DB, body, config);
    if (path === '/api/auth/login/options') {
      const options = await generateAuthenticationOptions({ rpID: config.rpID, userVerification: 'required', timeout: 120000 });
      return await saveChallenge(env.DB, options, 'login');
    }
    return await loginVerify(request, env.DB, body, config);
  } catch (error) {
    if (error instanceof AuthError) return json({ error: error.message, code: error.code }, error.status,
      error.status === 429 ? { 'Retry-After': '60' } : {});
    // Never log WebAuthn responses, invitation links, session tokens or DB errors.
    return json({ error: '登录服务暂时不可用，请稍后重试。', code: 'AUTH_UNAVAILABLE' }, 503);
  }
}

export {deployment,readMutation,rateLimit};
