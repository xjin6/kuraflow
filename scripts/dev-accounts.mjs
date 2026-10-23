import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {provisionPlatform,migrateExistingOrganizations} from '../backend/accounts.js';
import {seedTenant} from '../backend/repository.js';
import {KitchenModel} from '../data.js';
import {loginToLocalPreview,previewPortal,previewPortals,scopedPreviewHeaders,scopedPreviewCookie} from './local-preview-login.mjs';
import {createLocalFlowRuntime} from './flow-local-runtime.mjs';
const root=path.resolve(import.meta.dirname,'..'),privateDir=path.join(root,'private-preview'),port=Number(process.env.ACCOUNTS_PORT||8787),origin=`http://localhost:${port}`;
await fs.mkdir(privateDir,{recursive:true,mode:0o700});
let codeKey;try{codeKey=await fs.readFile(path.join(privateDir,'store-code.key'),'utf8');}catch{codeKey=randomBytes(32).toString('hex');await fs.writeFile(path.join(privateDir,'store-code.key'),codeKey,{mode:0o600});}
await fs.mkdir(path.join(root,'dist-worker'),{recursive:true});
await build({entryPoints:[path.join(root,'backend/worker.js')],outfile:path.join(root,'dist-worker/accounts-worker.mjs'),bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*']});
const mime={'.mjs':'text/javascript; charset=utf-8','.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf'};
const runtime=new Miniflare(convertV4MiniflareOptions({resourcePersistencePath:path.join(privateDir,'accounts-runtime'),workers:[{name:'kuraflow-accounts-preview',modules:true,scriptPath:path.join(root,'dist-worker/accounts-worker.mjs'),compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat','enable_request_signal'],d1Databases:{DB:'kuraflow-accounts-preview'},kvNamespaces:['MEDIA'],bindings:{PUBLIC_ORIGIN:'',LOCAL_TEST:'1',STORE_CODE_KEY:codeKey},serviceBindings:{ASSETS:async request=>{const relative=decodeURIComponent(new URL(request.url).pathname).replace(/^\//,'')||'index.html',file=path.resolve(root,'dist-cloud',relative);if(!file.startsWith(path.join(root,'dist-cloud')+path.sep))return new Response('Not found',{status:404});try{return new Response(await fs.readFile(file),{headers:{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'}});}catch{return new Response('Not found',{status:404});}}}}]}));
const db=await runtime.getD1Database('DB');
for(const name of (await fs.readdir(path.join(root,'backend/migrations'))).filter(n=>n.endsWith('.sql')).sort())await db.exec((await fs.readFile(path.join(root,'backend/migrations',name),'utf8')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
if(!await db.prepare('SELECT id FROM tenants LIMIT 1').first()){const model=new KitchenModel();await seedTenant(db,{tenantId:'local-demo-kitchen',state:model.state});}
let platformKey;
try { platformKey=(await fs.readFile(path.join(privateDir,'platform-key.txt'),'utf8')).trim(); } catch {}
const setup=await provisionPlatform(db,{key:platformKey});
if(setup.platformKey)await fs.writeFile(path.join(privateDir,'platform-key.txt'),setup.platformKey+'\n',{mode:0o600});
await migrateExistingOrganizations(db,{STORE_CODE_KEY:codeKey});
const flowService=createLocalFlowRuntime({db,privateDir,codeKey});
await flowService.importConnections();
const server=http.createServer(async(req,res)=>{try{
 if(![`localhost:${port}`,`127.0.0.1:${port}`].includes(req.headers.host)){res.writeHead(403);res.end('Local preview only');return;}
 const requestURL=new URL(req.url,'http://'+req.headers.host);
 if(['/__local-preview/phone','/__local-preview/phone.js'].includes(requestURL.pathname)){
  const script=requestURL.pathname.endsWith('.js');
  res.writeHead(200,{'Content-Type':script?'application/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(await fs.readFile(path.join(root,'scripts',script?'phone-preview.js':'phone-preview.html')));return;
 }
 if(requestURL.pathname==='/__local-preview/entry.js'){
  res.writeHead(200,{'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(await fs.readFile(path.join(root,'scripts/local-preview-entry.js')));return;
 }
 if(req.url==='/local-setup'){
  res.writeHead(302,{Location:origin+'/?login=platform','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return;
 }
 const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1500000){res.writeHead(413);res.end('Request too large');return;}parts.push(chunk);}
 const bytes=Buffer.concat(parts);
 if(requestURL.pathname==='/__local-preview/login'){
  const response=await loginToLocalPreview(new Request(requestURL,{method:req.method,headers:req.headers,...(bytes.length?{body:bytes}:{})}),{db,env:{DB:db,LOCAL_TEST:'1',PUBLIC_ORIGIN:''}});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));return;
 }
 let portal=req.headers['x-kuraflow-preview-portal'];
 if(!previewPortals.has(portal)&&req.headers.referer){try{const ref=new URL(req.headers.referer);if(ref.origin===requestURL.origin)portal=previewPortal(ref);}catch{}}
 if(requestURL.pathname.startsWith('/api/flow/')||requestURL.pathname==='/api/platform/flow'||requestURL.pathname.startsWith('/api/platform/flow/')){
  const controller=new AbortController();res.once('close',()=>controller.abort());
  const response=await flowService.handle(new Request(requestURL,{method:req.method,headers:scopedPreviewHeaders(req.headers,portal),signal:controller.signal,...(bytes.length?{body:bytes}:{})}));
  res.writeHead(response.status,Object.fromEntries(response.headers));
  if(response.body)for await(const chunk of response.body){if(res.destroyed)break;if(!res.write(Buffer.from(chunk)))await once(res,'drain',{signal:controller.signal});}
  res.end();return;
 }
 const response=await runtime.dispatchFetch(requestURL.href,{method:req.method,headers:scopedPreviewHeaders(req.headers,portal),...(bytes.length?{body:bytes}:{})});
 const headers=new Headers(response.headers);headers.set('Referrer-Policy','same-origin');
 const cookies=response.headers.getSetCookie();headers.delete('Set-Cookie');
 let body=Buffer.from(await response.arrayBuffer());
 if(headers.get('Content-Type')?.includes('text/html')){
  headers.set('X-Frame-Options','SAMEORIGIN');headers.set('Content-Security-Policy',headers.get('Content-Security-Policy').replace("frame-ancestors 'none'","frame-ancestors 'self'"));
 }
 if(headers.get('Content-Type')?.includes('text/html'))body=Buffer.from(body.toString('utf8').replace('</head>','<script src="/__local-preview/entry.js"></script></head>'));
 headers.delete('Content-Length');
 res.writeHead(response.status,{...Object.fromEntries(headers),...(cookies.length?{'Set-Cookie':cookies.map(value=>scopedPreviewCookie(value,portal))}:{})});res.end(body);
 }catch(error){if(res.headersSent){if(!res.destroyed)res.end();}else{res.writeHead(500);res.end('Local preview unavailable');}if(error.name!=='AbortError')console.error('Local preview request failed');}});
server.listen(port,'127.0.0.1',()=>console.log(`Account preview ready: ${origin}/local-setup (persistent local data; no production access)`));
const close=async()=>{server.close();await flowService.dispose();await runtime.dispose();process.exit(0);};process.on('SIGTERM',close);process.on('SIGINT',close);
