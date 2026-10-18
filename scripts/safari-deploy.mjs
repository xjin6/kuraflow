// Deploy exclusively through the user's approved, logged-in Safari account.
// Session cookies and short-lived upload JWTs remain in the browser.
import fs from 'node:fs';
import path from 'node:path';
import { hash } from 'blake3-wasm';
import { ACCOUNT, DB, MEDIA, ORIGIN, API, safari, guardDashboard, putPayload, runPage, apiRequest } from './safari-bridge.mjs';

process.chdir(path.resolve(import.meta.dirname,'..'));
guardDashboard();
const command=process.argv[2];
if(command==='configure') {
  const config=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
  config.account_id=ACCOUNT;
  config.d1_databases[0].database_id=DB;
  config.kv_namespaces[0].id=MEDIA;
  config.vars.PUBLIC_ORIGIN=ORIGIN;
  config.vars.LOCAL_TEST='0';
  fs.writeFileSync('wrangler.jsonc',JSON.stringify(config,null,2)+'\n');
  console.log('Production account, origin and bindings configured.');
} else if(command==='migrate') {
  for(const filename of fs.readdirSync('backend/migrations').filter(x=>x.endsWith('.sql')).sort()) {
    const result=await apiRequest(`/d1/database/${DB}/query`,'POST',{sql:fs.readFileSync('backend/migrations/'+filename,'utf8')});
    if(result.some(x=>x.success===false))throw new Error('Migration failed: '+filename);
    console.log(filename+': applied');
  }
} else if(command==='seed') {
  const counts=await apiRequest(`/d1/database/${DB}/query`,'POST',{sql:'SELECT COUNT(*) AS n FROM tenants'});
  if(counts[0].results[0].n!==0)throw new Error('Database already contains tenants; will not replace data.');
  const queries=JSON.parse(fs.readFileSync('private-deploy/seed-queries.json','utf8'));
  for(let i=0;i<queries.length;i++){
    const result=await apiRequest(`/d1/database/${DB}/query`,'POST',queries[i]);
    if(result.some(x=>x.success===false))throw new Error('Seed query failed: '+i);
    console.log('Private seed query '+(i+1)+' applied.');
  }
  console.log(JSON.stringify(await apiRequest(`/d1/database/${DB}/query`,'POST',{sql:'SELECT (SELECT COUNT(*) FROM tenants) AS tenants, (SELECT COUNT(*) FROM products) AS products, (SELECT COUNT(*) FROM documents) AS documents, (SELECT COUNT(*) FROM orders) AS orders, (SELECT COUNT(*) FROM private_materials) AS private_materials'})));
} else if(command==='assets') {
  const root=path.resolve('dist-cloud'), manifest={}, files={};
  const mimes={'.html':'text/html','.css':'text/css','.js':'application/javascript','.svg':'image/svg+xml','.jpg':'image/jpeg','.png':'image/png','.webp':'image/webp'};
  function walk(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,item.name);
    if(item.isDirectory()){walk(full);continue;}
    const relative='/'+path.relative(root,full).split(path.sep).join('/');
    if(relative==='/_headers'||relative==='/_redirects')continue;
    if(!mimes[path.extname(full)])throw new Error('Unexpected public asset: '+relative);
    const bytes=fs.readFileSync(full),base64=bytes.toString('base64');
    const digest=hash(base64+path.extname(full).slice(1)).toString('hex').slice(0,32);
    manifest[relative]={hash:digest,size:bytes.length};
    files[digest]={base64,mime:mimes[path.extname(full)]};
  }}
  walk(root);
  putPayload({manifest});
  const buckets=await runPage(`
    delete window.__kfAssetCompletion;
    const response=await fetch('${API}/workers/scripts/kuraflow-kitchen/assets-upload-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(window.__kfPayload)});
    const data=await response.json();
    if(!response.ok||!data.success)throw new Error('Manifest '+response.status+': '+JSON.stringify(data.errors));
    window.__kfAssetUpload=data.result;
    if(!data.result.buckets.length)window.__kfAssetCompletion=data.result.jwt;
    return data.result.buckets;
  `);
  console.log(Object.keys(manifest).length+' public assets, '+buckets.length+' upload buckets.');
  for(let i=0;i<buckets.length;i++){
    putPayload(buckets[i].map(h=>({hash:h,...files[h]})));
    const result=await runPage(`
      const form=new FormData();
      for(const file of window.__kfPayload)form.set(file.hash,new File([file.base64],file.hash,{type:file.mime}));
      const response=await fetch('${API}/workers/assets/upload?base64=true',{method:'POST',headers:{Authorization:'Bearer '+window.__kfAssetUpload.jwt},body:form});
      const data=await response.json();
      if(!response.ok||data.success===false)throw new Error('Asset upload '+response.status+': '+JSON.stringify(data.errors));
      if(data.result?.jwt)window.__kfAssetCompletion=data.result.jwt;
      return {status:response.status,complete:!!window.__kfAssetCompletion};
    `);
    console.log('Bucket '+(i+1)+': '+JSON.stringify(result));
  }
  console.log('Completion token present: '+safari('!!window.__kfAssetCompletion'));
} else if(command==='worker') {
  const config=JSON.parse(fs.readFileSync('wrangler.jsonc','utf8'));
  const metadata={main_module:'worker.js',compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags,
    assets:{config:{not_found_handling:'single-page-application',run_worker_first:['/api/*'],_headers:fs.readFileSync('dist-cloud/_headers','utf8')}},
    bindings:[{type:'assets',name:'ASSETS'},{type:'d1',name:'DB',id:DB},{type:'kv_namespace',name:'MEDIA',namespace_id:MEDIA},{type:'plain_text',name:'PUBLIC_ORIGIN',text:ORIGIN},{type:'plain_text',name:'LOCAL_TEST',text:'0'}],
    observability:config.observability};
  const secrets=JSON.parse(fs.readFileSync('private-deploy/worker-secrets.json','utf8'));
  if(!/^[a-f0-9]{64}$/.test(secrets.STORE_CODE_KEY||''))throw new Error('Production store-code key is missing.');
  metadata.bindings.push({type:'secret_text',name:'STORE_CODE_KEY',text:secrets.STORE_CODE_KEY});
  putPayload({metadata,source:fs.readFileSync('dist-worker/release/worker.js','utf8')});
  const result=await runPage(`
    if(!window.__kfAssetCompletion)throw new Error('No asset completion token; upload assets first.');
    window.__kfPayload.metadata.assets.jwt=window.__kfAssetCompletion;
    const form=new FormData();
    form.set('metadata',JSON.stringify(window.__kfPayload.metadata));
    form.set('worker.js',new File([window.__kfPayload.source],'worker.js',{type:'application/javascript+module'}));
    const response=await fetch('${API}/workers/scripts/kuraflow-kitchen',{method:'PUT',body:form});
    const data=await response.json();
    if(!response.ok||!data.success)throw new Error('Worker upload '+response.status+': '+JSON.stringify(data.errors));
    delete window.__kfAssetCompletion;delete window.__kfAssetUpload;delete window.__kfPayload;
    return {status:response.status,id:data.result.id,deployment_id:data.result.deployment_id,startup_time_ms:data.result.startup_time_ms};
  `);
  fs.writeFileSync('private-deploy/production-release.json',JSON.stringify({account:ACCOUNT,database:DB,media:MEDIA,origin:ORIGIN,uploadedAt:new Date().toISOString(),...result},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(result));
} else if(command==='enable') {
  console.log(JSON.stringify(await apiRequest('/workers/scripts/kuraflow-kitchen/subdomain','POST',{enabled:true,previews_enabled:false})));
} else throw new Error('Use configure, migrate, seed, assets, worker or enable.');
