import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {provisionPlatform,migrateExistingOrganizations} from '../backend/accounts.js';
import {seedTenant} from '../backend/repository.js';
import {KitchenModel} from '../data.js';
const root=path.resolve(import.meta.dirname,'..'),privateDir=path.join(root,'private-preview'),port=Number(process.env.ACCOUNTS_PORT||8787),origin=`http://localhost:${port}`;
await fs.mkdir(privateDir,{recursive:true,mode:0o700});
let codeKey;try{codeKey=await fs.readFile(path.join(privateDir,'store-code.key'),'utf8');}catch{codeKey=randomBytes(32).toString('hex');await fs.writeFile(path.join(privateDir,'store-code.key'),codeKey,{mode:0o600});}
await fs.mkdir(path.join(root,'dist-worker'),{recursive:true});
await build({entryPoints:[path.join(root,'backend/worker.js')],outfile:path.join(root,'dist-worker/accounts-worker.mjs'),bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*']});
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf'};
const runtime=new Miniflare(convertV4MiniflareOptions({resourcePersistencePath:path.join(privateDir,'accounts-runtime'),workers:[{name:'kuraflow-accounts-preview',modules:true,scriptPath:path.join(root,'dist-worker/accounts-worker.mjs'),compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'kuraflow-accounts-preview'},kvNamespaces:['MEDIA'],bindings:{PUBLIC_ORIGIN:'',LOCAL_TEST:'1',STORE_CODE_KEY:codeKey},serviceBindings:{ASSETS:async request=>{const relative=decodeURIComponent(new URL(request.url).pathname).replace(/^\//,'')||'index.html',file=path.resolve(root,'dist-cloud',relative);if(!file.startsWith(path.join(root,'dist-cloud')+path.sep))return new Response('Not found',{status:404});try{return new Response(await fs.readFile(file),{headers:{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'}});}catch{return new Response('Not found',{status:404});}}}}]}));
const db=await runtime.getD1Database('DB');
for(const name of (await fs.readdir(path.join(root,'backend/migrations'))).filter(n=>n.endsWith('.sql')).sort())await db.exec((await fs.readFile(path.join(root,'backend/migrations',name),'utf8')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
if(!await db.prepare('SELECT id FROM tenants LIMIT 1').first()){const model=new KitchenModel();await seedTenant(db,{tenantId:'local-demo-kitchen',state:model.state});}
let platformKey;
try { platformKey=(await fs.readFile(path.join(privateDir,'platform-key.txt'),'utf8')).trim(); } catch {}
const setup=await provisionPlatform(db,{key:platformKey});
if(setup.platformKey)await fs.writeFile(path.join(privateDir,'platform-key.txt'),setup.platformKey+'\n',{mode:0o600});
await migrateExistingOrganizations(db,{STORE_CODE_KEY:codeKey});
const server=http.createServer(async(req,res)=>{try{
 if(![`localhost:${port}`,`127.0.0.1:${port}`].includes(req.headers.host)){res.writeHead(403);res.end('Local preview only');return;}
 if(req.url==='/local-setup'){
  res.writeHead(302,{Location:origin+'/?login=platform','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});res.end();return;
 }
 const parts=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1500000){res.writeHead(413);res.end('Request too large');return;}parts.push(chunk);}
 const bytes=Buffer.concat(parts),response=await runtime.dispatchFetch('http://'+req.headers.host+req.url,{method:req.method,headers:req.headers,...(bytes.length?{body:bytes}:{})});
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){res.writeHead(500);res.end('Local preview unavailable');console.error(error.message);}});
server.listen(port,'127.0.0.1',()=>console.log(`Account preview ready: ${origin}/local-setup (persistent local data; no production access)`));
const close=async()=>{server.close();await runtime.dispose();process.exit(0);};process.on('SIGTERM',close);process.on('SIGINT',close);
