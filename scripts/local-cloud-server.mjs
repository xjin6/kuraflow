import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import fs from 'node:fs/promises';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {seedTenant} from '../backend/repository.js';
import {createInvite} from '../backend/auth.js';
const root=path.resolve(import.meta.dirname,'..');
await fs.mkdir(path.join(root,'dist-worker'),{recursive:true});
await build({entryPoints:[path.join(root,'backend/worker.js')],outfile:path.join(root,'dist-worker/local-worker.mjs'),bundle:true,format:'esm',platform:'neutral',mainFields:['module','main'],conditions:['workerd','worker','browser'],external:['node:*']});
const runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'kuraflow-local',modules:true,scriptPath:path.join(root,'dist-worker/local-worker.mjs'),compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],d1Databases:{DB:'kuraflow-local'},kvNamespaces:['MEDIA'],bindings:{PUBLIC_ORIGIN:'',LOCAL_TEST:'1',STORE_CODE_KEY:randomBytes(32).toString('hex')},serviceBindings:{ASSETS:async request=>{
 const url=new URL(request.url), relative=decodeURIComponent(url.pathname).replace(/^\//,'')||'index.html';
 const file=path.resolve(root,'dist-cloud',relative);
 if(!file.startsWith(path.join(root,'dist-cloud')+path.sep))return new Response('Not found',{status:404});
 try{const data=await fs.readFile(file);return new Response(data,{headers:{'Content-Type':({'.mjs':'text/javascript','.html':'text/html','.css':'text/css','.js':'text/javascript','.jpg':'image/jpeg','.svg':'image/svg+xml'})[path.extname(file)]||'application/octet-stream'}});}catch{return new Response('Not found',{status:404});}
}}}]}));
const db=await runtime.getD1Database('DB');
for(const file of (await fs.readdir(path.join(root,'backend/migrations'))).filter(x=>x.endsWith('.sql')).sort())await db.exec((await fs.readFile(path.join(root,'backend/migrations',file),'utf8')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
const initial=JSON.parse(await fs.readFile(path.join(root,'private-deploy/seed-state.json'),'utf8'));
await seedTenant(db,initial);
const admin=await createInvite(db,{tenantId:initial.tenantId,role:'admin',displayName:'本地验收管理员',expiresInSeconds:3600});
const store=await createInvite(db,{tenantId:initial.tenantId,role:'store',storeId:'s-kobe',displayName:'本地验收门店',expiresInSeconds:3600});
await fs.writeFile(path.join(root,'private-deploy/local-invites.json'),JSON.stringify({admin:admin.token,store:store.token}),{mode:0o600});
const server=http.createServer(async(req,res)=>{try{
 const chunks=[];for await(const c of req)chunks.push(c);
 const body=Buffer.concat(chunks);const response=await runtime.dispatchFetch('http://localhost:8787'+req.url,{method:req.method,headers:req.headers,...(body.length?{body}:{} )});
 res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
}catch(e){res.writeHead(500);res.end('Local test error');console.error(e.message);}});
server.listen(8787,'127.0.0.1',()=>console.log('Cloud runtime test at http://localhost:8787 (local invitations saved privately).'));
process.on('SIGTERM',async()=>{server.close();await runtime.dispose();process.exit(0);});
