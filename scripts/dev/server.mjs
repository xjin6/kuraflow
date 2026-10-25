import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {projectRoot, browserSources, styleSources, iconSources, privateSeed} from '../lib/project-paths.mjs';

const port=Number(process.env.PORT||4173);
const mime={'.mjs':'text/javascript','.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ttf':'font/ttf','.pdf':'application/pdf','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
const files=new Map(Object.entries({...styleSources,...iconSources,'index.html':'index.html'}));
for(const source of Object.values(browserSources))files.set(source,source);
files.set(privateSeed,privateSeed);
files.set('src/i18n/index.js','src/i18n/index.js');
files.set('src/i18n/messages.js','src/i18n/messages.js');
for(const locale of ['ja','en','vi'])files.set(`src/i18n/locales/${locale}.js`,`src/i18n/locales/${locale}.js`);
for(const file of ['public/vendor/pdf-engine.js','public/vendor/pdf-engine.LICENSE.txt','public/vendor/fontkit-LICENSE.txt','public/fonts/KuraflowDocumentSans.ttf','public/fonts/KuraflowDocumentSerif.ttf','public/fonts/NotoSansSC-LICENSE.txt','public/fonts/Geist-Variable.woff2','public/fonts/GeistMono-Variable.woff2','public/fonts/LICENSE.txt'])files.set(file,file);
for(const file of ['永辉株式会社10.5纳品书.pdf','附件一：产品清单.pdf','每度商事产品成本价格表.xlsx','每度商事_客户产品报价单_.pdf','杨国福京都河原店_2026年9月请求书_含运费.pdf','订货单案例.jpg'])files.set('materials/'+file,'private-preview/materials/'+file);
for(const color of ['blue','purple','orange'])for(const suffix of ['.svg','-32.png','-apple-touch.png','-kanji.svg','-english.svg','-sidebar-kanji.svg','-sidebar-english.svg']){
  const file=`public/brand/kuraflow-${color}${suffix}`;files.set(file,file);
}
const server=http.createServer(async(request,response)=>{
  try {
    const pathname=new URL(request.url,'http://localhost').pathname;
    const name=pathname==='/'?'index.html':decodeURIComponent(pathname.slice(1));
    let source=files.get(name);
    if(name==='__local-preview/phone')source='scripts/dev/phone-preview.html';
    else if(name==='__local-preview/phone.js')source='scripts/dev/phone-preview.js';
    else if(name==='flow-attachment-reader.js'||name===browserSources['flow-attachment-reader.js'])source='dist-cloud/public/vendor/flow-attachment-reader.js';
    else if(Object.hasOwn(browserSources,name)){
      // Native ES modules resolve imports against their final response URL.
      response.writeHead(307,{Location:'/'+browserSources[name],'Cache-Control':'no-store'});response.end();return;
    }
    if(/^public\/vendor\/pdfjs\/(pdf\.mjs|pdf\.worker\.min\.mjs|cmaps\/[A-Za-z0-9_.-]+|standard_fonts\/[A-Za-z0-9_.-]+)$/.test(name))source='dist-cloud/'+name;
    const photo=/^public\/product-images\/(\d+)\.jpg$/.exec(name);
    if(photo&&Number(photo[1])>=1&&Number(photo[1])<=72)source=name;
    if(!source){response.writeHead(404);response.end('Not found');return;}
    const body=await readFile(path.join(projectRoot,source)),extension=path.extname(source);
    response.writeHead(200,{'Content-Type':(mime[extension]||'application/octet-stream')+(['.html','.js','.mjs','.css','.svg'].includes(extension)?'; charset=utf-8':''),'Cache-Control':'no-store'});
    response.end(request.method==='HEAD'?undefined:body);
  } catch {response.writeHead(500);response.end('Unable to load the prototype');}
});
server.listen(port,'127.0.0.1',()=>console.log(`倉流 KURAFLOW is ready at http://127.0.0.1:${port}`));
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
