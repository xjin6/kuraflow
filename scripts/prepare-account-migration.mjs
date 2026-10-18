// Prepare the approved production account migration without network access.
// The plaintext platform key stays in a private local file; SQL contains its hash.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomBytes, randomUUID} from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const privateDir = path.join(root, 'private-deploy');
const target = {
  account:'416d8e8c519ddc0a60ead4fc98a2ae14',
  database:'c7bea510-68e6-4cc3-a746-794987746d80',
  worker:'kuraflow-kitchen',
};
const config = JSON.parse(await fs.readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
if (config.account_id !== target.account || config.name !== target.worker ||
    config.d1_databases?.find(binding => binding.binding === 'DB')?.database_id !== target.database ||
    config.vars?.LOCAL_TEST !== '0') throw new Error('Production target does not match.');

await fs.mkdir(privateDir, {recursive:true, mode:0o700});
await fs.chmod(privateDir, 0o700);
const keyPath = path.join(privateDir, 'platform-key.txt');
const provisionPath = path.join(privateDir, 'platform-provision.json');
async function readPrivate(filename) {
  try {
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Private provision path must be a regular file.');
    await fs.chmod(filename, 0o600);
    return await fs.readFile(filename, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
const provisionText = await readPrivate(provisionPath);
let platformKey = (await readPrivate(keyPath))?.trim();
if (!platformKey) {
  if (provisionText !== null) throw new Error('Platform provision metadata exists but its key is missing. Restore the private key; do not rotate it automatically.');
  platformKey = 'KF-PLATFORM-' + randomBytes(48).toString('base64url');
  await fs.writeFile(keyPath, platformKey + '\n', {mode:0o600, flag:'wx'});
}
if (!/^KF-PLATFORM-[A-Za-z0-9_-]{64}$/.test(platformKey)) throw new Error('Existing platform key format is invalid; no files were replaced.');
const keyHash = createHash('sha256').update(platformKey).digest('hex');
let provision;
if (provisionText !== null) {
  provision = JSON.parse(provisionText);
  if (Object.entries(target).some(([key, value]) => provision[key] !== value) ||
      provision.keyHash !== keyHash ||
      !/^[a-f0-9-]{36}$/.test(provision.accountId || '') ||
      provision.loginId !== 'platform:' + provision.accountId ||
      !Number.isSafeInteger(provision.createdAt) || provision.createdAt <= 0) {
    throw new Error('Existing platform provision metadata does not match; no credential was replaced.');
  }
} else {
  const accountId = randomUUID();
  provision = {...target, accountId, loginId:'platform:' + accountId, keyHash,
    createdAt:Math.floor(Date.now() / 1000)};
  await fs.writeFile(provisionPath, JSON.stringify(provision, null, 2) + '\n', {mode:0o600, flag:'wx'});
}

const queries = [];
const migrations = [];
for (const filename of ['0005_staff_accounts.sql', '0006_master_keys.sql']) {
  const source = await fs.readFile(path.join(root, 'backend/migrations', filename), 'utf8');
  // These reviewed migrations contain simple CREATE statements, without triggers
  // or semicolons in quoted literals. Refuse new statement types for review.
  const statements = source.replace(/--[^\n]*/g, '').split(';').map(sql => sql.trim()).filter(Boolean);
  if (statements.some(sql => !/^CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS\b/.test(sql))) {
    throw new Error('Migration statements changed and require review: ' + filename);
  }
  for (const sql of statements) queries.push({sql, params:[]});
  migrations.push({name:filename, sha256:createHash('sha256').update(source).digest('hex')});
}
const schemaQueryCount = queries.length;
const owner = "role='platform' AND account_role='owner'";
const assert = (predicate, params=[]) => ({
  sql:`INSERT INTO auth_atomic_guard(id,ok) VALUES(1,CASE WHEN ${predicate} THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok`,
  params,
});
// Refuse an unexpected existing credential before any account changes. An owner
// without an account_key is the legacy account schema and can be converted.
queries.push(assert(`NOT EXISTS(SELECT 1 FROM staff_accounts a JOIN account_keys k ON k.account_id=a.id WHERE a.${owner.replaceAll(' AND ', ' AND a.')} AND (k.kind!='platform' OR k.key_hash!=? OR k.key_cipher IS NOT NULL OR a.status!='active' OR a.password_hash IS NOT NULL))`, [keyHash]));
queries.push({
  sql:`INSERT INTO staff_accounts(id,login_id,role,account_role,name,contact,status,password_hash,created_at) SELECT ?,?,'platform','owner','平台负责人','','active',NULL,? WHERE NOT EXISTS(SELECT 1 FROM staff_accounts WHERE ${owner})`,
  params:[provision.accountId, provision.loginId, provision.createdAt],
});
queries.push({
  sql:`UPDATE staff_accounts SET login_id='platform:'||id,status='active',password_hash=NULL,version=version+1 WHERE ${owner} AND NOT EXISTS(SELECT 1 FROM account_keys WHERE account_id=staff_accounts.id) AND (login_id!='platform:'||id OR status!='active' OR password_hash IS NOT NULL)`,
  params:[],
});
for (const table of ['account_sessions', 'account_invites']) queries.push({
  sql:`DELETE FROM ${table} WHERE account_id IN(SELECT id FROM staff_accounts WHERE ${owner} AND NOT EXISTS(SELECT 1 FROM account_keys WHERE account_id=staff_accounts.id))`,
  params:[],
});
queries.push({
  sql:`INSERT INTO account_keys(account_id,kind,key_hash,key_cipher,created_at) SELECT id,'platform',?,NULL,? FROM staff_accounts WHERE ${owner} AND NOT EXISTS(SELECT 1 FROM account_keys WHERE account_id=staff_accounts.id)`,
  params:[keyHash, provision.createdAt],
});
queries.push(assert(`(SELECT COUNT(*) FROM staff_accounts a JOIN account_keys k ON k.account_id=a.id WHERE a.${owner.replaceAll(' AND ', ' AND a.')} AND a.status='active' AND a.password_hash IS NULL AND k.kind='platform' AND k.key_hash=? AND k.key_cipher IS NULL)=1`, [keyHash]));
queries.push({
  sql:`SELECT a.id AS account_id,a.login_id,a.status,k.kind,k.key_cipher IS NULL AS hash_only FROM staff_accounts a JOIN account_keys k ON k.account_id=a.id WHERE a.${owner.replaceAll(' AND ', ' AND a.')}`,
  params:[],
});
const payload = {...target, migrations, schemaQueryCount, queries};
const output = path.join(privateDir, 'account-migration.json');
await fs.writeFile(output, JSON.stringify(payload, null, 2) + '\n', {mode:0o600});
await fs.chmod(output, 0o600);
console.log(`Prepared ${schemaQueryCount} additive schema statements and ${queries.length - schemaQueryCount} platform bootstrap/verification statements. No network requests made; private key preserved.`);
