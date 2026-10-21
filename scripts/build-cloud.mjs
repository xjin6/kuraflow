import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
await import('./build-pdf-engine.mjs');
const root=path.resolve(import.meta.dirname,'..');
const target=path.join(root,'dist-cloud');
await fs.rm(target,{recursive:true,force:true});
await fs.mkdir(target,{recursive:true});
const sourceAlias={name:'private-data-boundary',setup(b){
 b.onResolve({filter:/business-data\.js$/},()=>({path:path.join(root,'cloud-seed.js')}));
 b.onLoad({filter:/\/data\.js$/},async args=>({contents:(await fs.readFile(args.path,'utf8')).replace("export const DEMO_DATE = '2026-10-08';","export const DEMO_DATE = new Date(Date.now()+32400000).toISOString().slice(0,10);"),loader:'js'}));
}};
await build({entryPoints:[path.join(root,'cloud-bootstrap.js')],outdir:path.join(target,'assets'),bundle:true,splitting:true,format:'esm',platform:'browser',target:['safari17','chrome120'],minify:true,sourcemap:false,entryNames:'[name]-[hash]',chunkNames:'chunk-[hash]',metafile:true,plugins:[sourceAlias]}).then(async result=>{
 // Inspect the dependency graph without embedding private values in source.
 const privateInputs=Object.keys(result.metafile.inputs).filter(input=>{
  const relative=path.relative(root,path.resolve(input)).split(path.sep).join('/');
  return relative==='business-data.js'||/^(?:materials|materials-derived|private-deploy|private-preview)\//.test(relative);
 });
 if(privateInputs.length)throw new Error('Private local data must not enter the browser bundle.');
 const entry=Object.entries(result.metafile.outputs).find(([,v])=>v.entryPoint?.endsWith('cloud-bootstrap.js'))?.[0];
 if(!entry)throw new Error('Cloud entry missing');
 const script='/'+path.relative(target,path.resolve(entry)).split(path.sep).join('/');
 let html=await fs.readFile(path.join(root,'index.html'),'utf8');
 html=html.replace('<link rel="stylesheet" href="./styles.css" />','<link rel="stylesheet" href="/cloud.css" /><link rel="stylesheet" href="./styles.css" />').replace('<script type="module" src="./app.js"></script>',`<script type="module" src="${script}"></script>`);
 await fs.writeFile(path.join(target,'index.html'),html);
});
for(const file of ['styles.css','catalogue-units.css','store-ui.css','readability.css','ui-system.css','ui-controls.css','order-ui.css','visual-refresh.css','settlement.css','overview.css','accounts.css','flow-ui.css','notifications.css','flow-mark.svg','cloud.css','favicon.svg'])await fs.copyFile(path.join(root,file),path.join(target,file));
await fs.cp(path.join(root,'public/product-images'),path.join(target,'public/product-images'),{recursive:true});
await fs.cp(path.join(root,'public/fonts'),path.join(target,'public/fonts'),{recursive:true});
await fs.mkdir(path.join(target,'public/vendor'),{recursive:true});
await fs.copyFile(path.join(root,'public/vendor/pdf-engine.LICENSE.txt'),path.join(target,'public/vendor/pdf-engine.LICENSE.txt'));
await fs.writeFile(path.join(target,'_headers'),`/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'\n`);
console.log('Cloud bundle built; private catalogue/cost/account/statement data excluded.');
