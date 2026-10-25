// Prepare a reviewed upload for the approved dashboard session.
// This script performs no network requests and never reads authentication secrets.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { hash } from 'blake3-wasm';

const root = path.resolve(import.meta.dirname, '../..');
const options = process.argv.slice(2);
if (options.some(option => option !== '--with-account-migration') || options.length > 1) throw new Error('Use --with-account-migration explicitly to include account schema/bootstrap.');
const includeAccountMigration = options.includes('--with-account-migration');
const config = JSON.parse(await fs.readFile(path.join(root, 'wrangler.jsonc'), 'utf8'));
const account = '416d8e8c519ddc0a60ead4fc98a2ae14';
const worker = 'kuraflow-kitchen';
const database = 'c7bea510-68e6-4cc3-a746-794987746d80';
const media = 'e8d6be95cdaf4221a88b803ece150354';
const origin = 'https://kuraflow-kitchen.xjin-general.workers.dev';
if (config.account_id !== account || config.name !== worker || config.vars.LOCAL_TEST !== '0' || config.vars.PUBLIC_ORIGIN !== origin || config.d1_databases[0]?.database_id !== database || config.kv_namespaces[0]?.id !== media) throw new Error('Production target does not match.');
let migration = null;
if (includeAccountMigration) {
  migration = JSON.parse(await fs.readFile(path.join(root, 'private-deploy/account-migration.json'), 'utf8'));
  if (migration.account !== account || migration.worker !== worker || migration.database !== database || !Array.isArray(migration.queries) || migration.queries.length === 0 || !Number.isInteger(migration.schemaQueryCount) || migration.schemaQueryCount <= 0 || migration.schemaQueryCount >= migration.queries.length) throw new Error('Account migration target or queries do not match.');
  for (const entry of migration.migrations || []) {
    if (!['0005_staff_accounts.sql', '0006_master_keys.sql'].includes(entry.name)) throw new Error('Unexpected account migration.');
    const digest = createHash('sha256').update(await fs.readFile(path.join(root, 'backend/migrations', entry.name))).digest('hex');
    if (digest !== entry.sha256) throw new Error('Account migration source changed; prepare it again.');
  }
  if (migration.migrations?.length !== 2 || new Set(migration.migrations.map(entry => entry.name)).size !== 2) throw new Error('Both account migrations are required.');
  if (migration.queries.some(query => typeof query.sql !== 'string' || !Array.isArray(query.params))) throw new Error('Invalid account migration query.');
}
const assetRoot = path.join(root, 'dist-cloud');
const manifest = {}, files = {};
const mime = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.svg':'image/svg+xml', '.jpg':'image/jpeg', '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2', '.ttf':'font/ttf', '.txt':'text/plain' };
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes:true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(full); continue; }
    const relative = '/' + path.relative(assetRoot, full).split(path.sep).join('/');
    if (relative === '/_headers' || relative === '/_redirects') continue;
    const extension = path.extname(full);
    if (!mime[extension]) throw new Error('Unexpected public asset: ' + relative);
    const bytes = await fs.readFile(full), base64 = bytes.toString('base64');
    const digest = hash(base64 + extension.slice(1)).toString('hex').slice(0, 32);
    manifest[relative] = { hash:digest, size:bytes.length };
    files[digest] = { base64, mime:mime[extension] };
  }
}
await walk(assetRoot);
const source = await fs.readFile(path.join(root, 'dist-worker/release/worker.js'), 'utf8');
const metadata = {
  main_module:'worker.js', compatibility_date:config.compatibility_date, compatibility_flags:config.compatibility_flags,
  keep_bindings:['secret_text','secret_key'],
  assets:{config:{...config.assets, directory:undefined, binding:undefined, _headers:await fs.readFile(path.join(assetRoot, '_headers'), 'utf8')}},
  bindings:[{type:'assets',name:'ASSETS'},
    {type:'d1',name:'DB',id:config.d1_databases[0].database_id},
    {type:'kv_namespace',name:'MEDIA',namespace_id:config.kv_namespaces[0].id},
    {type:'plain_text',name:'PUBLIC_ORIGIN',text:config.vars.PUBLIC_ORIGIN},
    {type:'plain_text',name:'LOCAL_TEST',text:'0'}],
  observability:config.observability,
  annotations:{'workers/message':'Right-aligned packing checklist, subtle completion, line notes and separate customer portals','workers/tag':'packing-checklist-20261019'},
};
const fingerprint = { workerSha256:createHash('sha256').update(source).digest('hex'), uiSha256:createHash('sha256').update(await fs.readFile(path.join(assetRoot,'ui-system.css'))).digest('hex') };
const payload = {account,worker,manifest,files,source,metadata,fingerprint,migration};
const encoded = gzipSync(JSON.stringify(payload)).toString('base64');
const program = `console.clear(); void (async () => {
  let stage = 'target validation';
  let migrationReceipt = null;
  try {
    if (!location.href.startsWith('https://dash.cloudflare.com/${account}/')) throw Error('Wrong dashboard account');
    const bytes = Uint8Array.from(atob(${JSON.stringify(encoded)}), c => c.charCodeAt(0));
    const p = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).json();
    const api = '/api/v4/accounts/' + p.account;
    const call = async (suffix, init) => {
      const response = await fetch(api + suffix, init);
      const data = await response.json();
      if (!response.ok || data.success === false) throw Error(stage + ': HTTP ' + response.status + ' codes ' + (data.errors || []).map(e => e.code).join(','));
      return data.result;
    };
    const settings = await call('/workers/scripts/' + p.worker + '/settings');
    const binding = name => settings.bindings.find(b => b.name === name);
    if (binding('DB')?.id !== p.metadata.bindings.find(b=>b.name==='DB').id || binding('MEDIA')?.namespace_id !== p.metadata.bindings.find(b=>b.name==='MEDIA').namespace_id || binding('STORE_CODE_KEY')?.type !== 'secret_text' || binding('PUBLIC_ORIGIN')?.text !== p.metadata.bindings.find(b=>b.name==='PUBLIC_ORIGIN').text || binding('LOCAL_TEST')?.text !== '0') throw Error('Existing production bindings do not match');
    if (p.migration) {
      if (p.migration.account !== p.account || p.migration.worker !== p.worker || p.migration.database !== binding('DB').id) throw Error('Account migration target does not match production');
      stage = 'database recovery bookmark';
      const recovery = await call('/d1/database/' + p.migration.database + '/time_travel/bookmark');
      if (typeof recovery?.bookmark !== 'string' || !recovery.bookmark) throw Error('D1 recovery bookmark unavailable; migration not started');
      migrationReceipt = {database:p.migration.database,beforeBookmark:recovery.bookmark,beforeTimestamp:new Date().toISOString(),status:'not-started'};
      console.log('KURAFLOW_MIGRATION_RECOVERY ' + JSON.stringify(migrationReceipt));
      stage = 'account schema and platform bootstrap';
      migrationReceipt.status = 'started';
      const migrated = await call('/d1/database/' + p.migration.database + '/query', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({batch:p.migration.queries})});
      if (!Array.isArray(migrated) || migrated.length !== p.migration.queries.length || migrated.some(result => result.success !== true)) throw Error('Account migration did not return a complete successful batch');
      const platform = migrated.at(-1)?.results;
      if (!Array.isArray(platform) || platform.length !== 1 || platform[0].status !== 'active' || platform[0].kind !== 'platform' || platform[0].hash_only !== 1 || typeof platform[0].account_id !== 'string') throw Error('Platform bootstrap verification failed');
      migrationReceipt = {...migrationReceipt,status:'applied',platformAccountId:platform[0].account_id,statements:migrated.length,migrations:p.migration.migrations};
      console.log('KURAFLOW_MIGRATION_DONE ' + JSON.stringify(migrationReceipt));
    }
    stage = 'asset manifest';
    console.log('KURAFLOW_RELEASE_STAGE checking ' + Object.keys(p.manifest).length + ' public assets');
    const upload = await call('/workers/scripts/' + p.worker + '/assets-upload-session', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({manifest:p.manifest})});
    let completion = upload.buckets.length ? null : upload.jwt;
    for (let i=0; i<upload.buckets.length; i++) {
      stage = 'asset bucket ' + (i+1);
      const form = new FormData();
      for (const digest of upload.buckets[i]) {
        const f=p.files[digest];
        if (!f) throw Error('Missing public asset');
        form.set(digest,new File([f.base64],digest,{type:f.mime}));
      }
      const result=await call('/workers/assets/upload?base64=true',{method:'POST',headers:{Authorization:'Bearer '+upload.jwt},body:form});
      if (result?.jwt) completion=result.jwt;
      console.log('KURAFLOW_RELEASE_STAGE uploaded bucket ' + (i+1) + '/' + upload.buckets.length);
    }
    if (!completion) throw Error('Asset completion token missing');
    stage = 'worker publish';
    p.metadata.assets.jwt=completion;
    const form=new FormData();
    form.set('metadata',JSON.stringify(p.metadata));
    form.set('worker.js',new File([p.source],'worker.js',{type:'application/javascript+module'}));
    const result=await call('/workers/scripts/'+p.worker,{method:'PUT',body:form});
    const receipt={account:p.account,worker:p.worker,deployment_id:result.deployment_id,uploadedAt:new Date().toISOString(),startup_time_ms:result.startup_time_ms,...p.fingerprint,...(migrationReceipt?{accountMigration:migrationReceipt}:{})};
    console.log('KURAFLOW_RELEASE_DONE '+JSON.stringify(receipt));
  } catch(error) { console.error('KURAFLOW_RELEASE_FAILED '+stage+': '+error.message); if (migrationReceipt) console.log('KURAFLOW_MIGRATION_RECOVERY '+JSON.stringify(migrationReceipt)); }
})();`;
const destination = path.join(root, 'private-deploy/dashboard-release-console.js');
await fs.writeFile(destination, program, { mode:0o600 });
await fs.writeFile(path.join(root,'private-deploy/release-build.json'),JSON.stringify({account,worker,assets:Object.keys(manifest).length,...fingerprint,accountMigration:includeAccountMigration},null,2)+'\n',{mode:0o600});
console.log(`Prepared ${Object.keys(manifest).length} assets; console payload ${Buffer.byteLength(program)} bytes. Existing secret bindings will be preserved.${includeAccountMigration?' Includes account migration after D1 recovery bookmark capture.':' No database migration included.'}`);
