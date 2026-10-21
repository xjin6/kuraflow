const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const fields = { name: 160, address: 400, phone: 80, representative: 120 };
const imagePath = /^\/api\/images\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (message, status = 400, code = 'DOCUMENT_PROFILE_INVALID') => {
  throw Object.assign(new Error(message), { status, code });
};
const object = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function scope(principal, write = false) {
  if (!principal) fail('请先登录。', 401, 'UNAUTHORIZED');
  if (!['admin', 'store'].includes(principal.role)
    || (write && (principal.role !== 'admin' || principal.accountRole !== 'owner')))
    fail(write ? '仅管理端负责人可以修改纳品书信息。' : '无权访问纳品书信息。', 403, 'FORBIDDEN');
  for (const key of ['tenantId', 'userId', ...(principal.role === 'store' ? ['storeId'] : [])]) {
    if (typeof principal[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(principal[key]))
      fail('账号范围不正确。', 403, 'FORBIDDEN');
  }
}

async function snapshot(db, principal) {
  const row = await db.prepare(`SELECT t.name, t.core_json, t.revision,
    json_extract(p.data_json, '$.company') AS company_json
    FROM tenants t LEFT JOIN private_materials p ON p.tenant_id=t.id WHERE t.id=?`)
    .bind(principal.tenantId).first();
  if (!row) fail('公司资料尚未初始化。', 404, 'TENANT_NOT_FOUND');
  const core = JSON.parse(row.core_json);
  if (principal.role === 'store' && !(core.stores || []).some(store => store.id === principal.storeId && !store.deletedAt))
    fail('门店不存在或已停用。', 403, 'STORE_NOT_FOUND');
  const company = JSON.parse(row.company_json || '{}');
  return { row, core, company: object(company) ? company : {} };
}

function normalizedIssuer(value, { strict = false, status = 400 } = {}) {
  if (!object(value)) fail('纳品书信息格式不正确。', status);
  if (strict && Object.keys(value).some(key => !own(fields, key) && key !== 'sealUrl'))
    fail('纳品书信息包含不支持的字段。');
  const issuer = {};
  for (const [key, max] of Object.entries(fields)) {
    const text = value[key] ?? '';
    if (typeof text !== 'string' || text.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
      || (key === 'name' && !text.trim())) fail(`纳品书${key === 'name' ? '公司名' : '信息'}不正确。`, status);
    issuer[key] = text.trim();
  }
  if (value.sealUrl != null) {
    if (typeof value.sealUrl !== 'string' || !imagePath.test(value.sealUrl))
      fail('公章图片必须先上传至当前公司。', status, 'DOCUMENT_SEAL_INVALID');
    issuer.sealUrl = value.sealUrl;
  }
  return issuer;
}

async function validateSeal(db, principal, issuer) {
  if (!issuer.sealUrl) return;
  const file = await db.prepare('SELECT id,mime FROM media_files WHERE id=? AND tenant_id=?')
    .bind(issuer.sealUrl.split('/').at(-1), principal.tenantId).first();
  if (!file || !['image/png', 'image/jpeg'].includes(file.mime))
    fail('公章图片不存在或不属于当前公司，请重新上传。', 409, 'DOCUMENT_SEAL_UNAVAILABLE');
}

export async function getDocumentProfile(db, principal) {
  scope(principal);
  const { row, core, company } = await snapshot(db, principal);
  const settings = object(core.settings) ? core.settings : {};
  const configured = object(settings.issuer) ? settings.issuer : {};
  // Only issuance fields cross this endpoint; procurement and account metadata
  // from the same tenant snapshot never form part of the public response.
  const fallback = {
    name: settings.companyName || company.name || row.name,
    address: company.address || '', phone: company.phone || '',
    representative: company.representative || company.contact || '',
  };
  const values = Object.fromEntries(Object.keys(fields).map(key => [key, own(configured, key) ? configured[key] : fallback[key]]));
  if (own(configured, 'sealUrl')) values.sealUrl = configured.sealUrl;
  const issuer = normalizedIssuer(values, { status: 409 });
  await validateSeal(db, principal, issuer);
  return { version: row.revision, issuer };
}

export async function saveDocumentProfile(db, principal, body) {
  scope(principal, true);
  if (!object(body) || Object.keys(body).some(key => !['version', 'issuer'].includes(key))
    || !Number.isSafeInteger(body.version) || body.version < 0) fail('纳品书信息版本不正确。');
  const issuer = normalizedIssuer(body.issuer, { strict: true });
  const { row, core } = await snapshot(db, principal);
  if (row.revision !== body.version) fail('公司资料已更新，请刷新后重试。', 409, 'DOCUMENT_PROFILE_CONFLICT');
  await validateSeal(db, principal, issuer);
  const settings = object(core.settings) ? core.settings : {};
  const priorIssuer = object(settings.issuer) ? settings.issuer : {};
  const next = { ...core, settings: { ...settings, issuer: { ...priorIssuer, ...issuer, sealUrl: issuer.sealUrl || null } } };
  const coreJSON = JSON.stringify(next);
  if (new TextEncoder().encode(coreJSON).byteLength > 1500000)
    fail('公司资料超过当前容量，请联系管理员归档。', 409, 'CAPACITY_LIMIT');
  const guardId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(`UPDATE tenants SET core_json=?,revision=revision+1 WHERE id=? AND revision=?
        AND (? IS NULL OR EXISTS(SELECT 1 FROM media_files WHERE id=? AND tenant_id=? AND mime IN ('image/png','image/jpeg')))`)
        .bind(coreJSON, principal.tenantId, body.version, issuer.sealUrl || null, issuer.sealUrl?.split('/').at(-1) || null, principal.tenantId),
      db.prepare('INSERT INTO business_write_assertion(id,ok) VALUES (?,changes())').bind(guardId),
      db.prepare('INSERT INTO business_audit_log(id,tenant_id,user_id,command,entity_id,revision,created_at) VALUES (?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), principal.tenantId, principal.userId, 'updateDocumentProfile', principal.tenantId, body.version + 1, new Date().toISOString()),
      db.prepare('DELETE FROM business_write_assertion WHERE id=?').bind(guardId),
    ]);
  } catch (error) {
    if (/business_revision_conflict/.test(String(error.message)))
      fail('公司资料已更新，请刷新后重试。', 409, 'DOCUMENT_PROFILE_CONFLICT');
    throw error;
  }
  return { version: body.version + 1, issuer };
}
