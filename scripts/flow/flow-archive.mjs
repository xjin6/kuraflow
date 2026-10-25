import {cleanAttachmentRefs} from '../../src/shared/flow-attachment-data.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {JSDOM} from 'jsdom';
import {cleanFlowMutation,cleanFlowProposal} from '../../backend/flow-content.js';

const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LIMIT=100;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const clip=(value,max=240)=>typeof value==='string'?value.slice(0,max):'';
export function flowActorKey(principal) {
  if(principal?.role!=='admin'||!principal.tenantId||!principal.userId||principal.storeId)fail('请先登录管理端。',403);
  return createHash('sha256').update(JSON.stringify([principal.tenantId,principal.userId])).digest('hex');
}
export function safeFlowImage(value) {
  return typeof value==='string'&&(/^\/api\/flow\/artifacts\/[a-f0-9-]{36}$/.test(value)&&UUID.test(value.split('/').at(-1))||/^\/public\/product-images\/[1-9][0-9]?\.jpg$/.test(value))?value:null;
}
const safeHref=value=>{
  if(typeof value!=='string'||!value.startsWith('/?'))return null;
  const u=new URL(value,'https://kuraflow.invalid');
  if(!['overview','orders','catalogue','stores','documents','tasks'].includes(u.searchParams.get('page'))||[...u.searchParams.keys()].some(k=>!['page','order','store','product','tab','month','from','to','range','demo'].includes(k)))return null;
  return u.pathname+u.search;
};
function messages(input) {
  if(!Array.isArray(input)||input.length>120)fail('对话过长，请新建对话。');
  if(JSON.stringify(input).length>512000)fail('对话内容过大，请新建对话。',413);
  return input.map(row=>{
    if(!row||!['user','assistant'].includes(row.role)||typeof row.text!=='string'||row.text.length>40000)fail('对话内容格式不正确。');
    return {role:row.role,text:row.text,
      ...(row.role==='user'&&row.attachments?.length?{attachments:cleanAttachmentRefs(row.attachments)}:{}),
      ...(row.role==='user'&&typeof row.requestId==='string'&&UUID.test(row.requestId)?{requestId:row.requestId}:{}),
      ...(row.role==='assistant'?{
        ...(row.pending===true?{pending:true}:{}),
        ...(Array.isArray(row.mutations)?{mutations:row.mutations.slice(0,6).map(cleanFlowMutation).filter(Boolean)}:{}),
        ...(Array.isArray(row.proposals)?{proposals:row.proposals.slice(0,6).map(cleanFlowProposal).filter(Boolean)}:{}),
        steps:(Array.isArray(row.steps)?row.steps:[]).slice(0,24).flatMap(step=>/^(?:prepare|model|answer|tool-\d{1,2})$/.test(step?.id)&&['running','done','error','stopped'].includes(step.status)?[{id:step.id,label:clip(step.label,80),status:step.status,...(step.detail?{detail:clip(step.detail,160)}:{})}]:[]),
        tools:(Array.isArray(row.tools)?row.tools:[]).slice(0,24).map(t=>({label:clip(typeof t==='string'?t:t?.label||t?.name,100)})),
        sources:(Array.isArray(row.sources)?row.sources:[]).slice(0,30).flatMap(s=>{const href=safeHref(s?.href||s?.url);return href?[{label:clip(s.label||s.title,160)||'查看记录',href}]:[];}),
        images:(Array.isArray(row.images)?row.images:[]).slice(0,8).flatMap(i=>{const url=safeFlowImage(i?.url);return url?[{id:clip(i.id,80),url,alt:clip(i.alt||i.title,200),title:clip(i.title,200)}]:[];}),
        ...(row.error?{error:clip(row.error)}:{}),...(row.stopped?{stopped:true}:{})}:{}),
    };
  });
}

// Generated visuals are inert SVG primitives, never model HTML, scripts or external assets.
export function sanitizeFlowSVG(value) {
  if(typeof value!=='string'||value.length>60000||/<!DOCTYPE|<!ENTITY|<\?/i.test(value))fail('图片内容不符合格式，请重新绘制。');
  let dom;
  try {dom=new JSDOM(value,{contentType:'image/svg+xml'});}catch{fail('图片 SVG 格式不完整，请重新绘制。');}
  try {
    const doc=dom.window.document,root=doc.documentElement;
    if(root.localName!=='svg'||root.namespaceURI!=='http://www.w3.org/2000/svg')fail('图片需要有效的 SVG 根元素。');
    const tags=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','linearGradient','radialGradient','stop','clipPath','title','desc']);
    const attrs=new Set(['xmlns','viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','opacity','fill-opacity','stroke-opacity','transform','id','gradientUnits','gradientTransform','offset','stop-color','stop-opacity','clip-path','text-anchor','dominant-baseline','font-family','font-size','font-weight','letter-spacing','dx','dy','fill-rule','clip-rule','preserveAspectRatio']);
    const colors=new Set(['none','transparent','currentColor','white','black','red','blue','green','gray','grey','orange','purple']);
    const ids=new Set();
    const elements=[root,...root.querySelectorAll('*')];
    if(elements.length>1200)fail('图片元素过多，请简化。');
    for(const el of elements) {
      if(!tags.has(el.localName)||el.namespaceURI!==root.namespaceURI||el.prefix||el!==root&&el.localName==='svg')fail('图片包含不支持的元素。');
      for(const attr of [...el.attributes]) {
        const {name,value:v}=attr;
        if(!attrs.has(name)||name!=='xmlns'&&(attr.prefix||attr.namespaceURI)||v.length>10000||/[\u0000-\u0008]/.test(v))fail('图片包含不支持的属性。');
        if(name==='xmlns'&&(el!==root||v!=='http://www.w3.org/2000/svg'))fail('图片命名空间不正确。');
        if(name==='id'){if(!/^[a-zA-Z][\w-]{0,50}$/.test(v)||ids.has(v))fail('图片元素标识不正确。');ids.add(v);}
        if(['fill','stroke','stop-color'].includes(name)&&!colors.has(v)&&!/^#[\da-fA-F]{3,8}$/.test(v)&&!/^rgba?\([\d.,%\s]+\)$/.test(v)&&!/^url\(#[a-zA-Z][\w-]{0,50}\)$/.test(v))fail('图片颜色格式不正确。');
        if(name==='clip-path'&&!/^url\(#[a-zA-Z][\w-]{0,50}\)$/.test(v))fail('图片剪裁格式不正确。');
        if(name==='font-family'&&!/^[a-zA-Z\s,\-'\u4e00-\u9fff]{1,120}$/.test(v))fail('图片字体格式不正确。');
        if(name!=='xmlns'&&/(?:javascript|https?:|data:|@import|expression)/i.test(v))fail('图片不允许外部资源。');
      }
    }
    const viewBox=(root.getAttribute('viewBox')||'0 0 800 500').trim().split(/[ ,]+/).map(Number);
    if(viewBox.length!==4||viewBox.some(n=>!Number.isFinite(n))||viewBox[2]<100||viewBox[3]<80||viewBox[2]>2400||viewBox[3]>2400)fail('图片尺寸需在 2400 像素以内。');
    root.setAttribute('viewBox',viewBox.join(' '));root.setAttribute('width',String(viewBox[2]));root.setAttribute('height',String(viewBox[3]));
    root.setAttribute('font-family','Arial, Noto Sans SC, sans-serif');
    return root.outerHTML;
  } finally {dom.window.close();}
}

export function createFlowArchive({privateDir}) {
  const base=path.join(privateDir,'flow-conversations'),queues=new Map();
  const actorDir=p=>path.join(base,flowActorKey(p));
  const checkedId=id=>{if(!UUID.test(id||''))fail('未找到该对话。',404);return id;};
  const filename=(p,id)=>path.join(actorDir(p),checkedId(id)+'.json');
  async function serial(p,task){const key=flowActorKey(p),last=queues.get(key)||Promise.resolve();const next=last.catch(()=>{}).then(task);queues.set(key,next);try{return await next;}finally{if(queues.get(key)===next)queues.delete(key);}}
  async function read(p,id){try{return JSON.parse(await fs.readFile(filename(p,id),'utf8'));}catch(e){if(e.code==='ENOENT')fail('未找到该对话。',404);throw e;}}
  async function write(p,row){const dir=actorDir(p);await fs.mkdir(dir,{recursive:true,mode:0o700});const file=filename(p,row.id),tmp=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(tmp,JSON.stringify(row),{mode:0o600,flag:'wx'});await fs.rename(tmp,file);}finally{await fs.rm(tmp,{force:true}).catch(()=>{});}}
  async function rows(p){let files;try{files=await fs.readdir(actorDir(p));}catch(e){if(e.code==='ENOENT')return [];throw e;}return Promise.all(files.filter(f=>f.endsWith('.json')&&UUID.test(f.slice(0,-5))).map(f=>read(p,f.slice(0,-5))));}
  const publicRow=row=>{const {deletedAt,...rest}=row;return rest;};
  async function get(p,id){const row=await read(p,id);if(row.deletedAt)fail('该对话已删除，可撤销删除后继续。',410);return publicRow(row);}
  async function list(p){return {limit:LIMIT,conversations:(await rows(p)).filter(r=>!r.deletedAt).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(r=>({id:r.id,title:r.title,updatedAt:r.updatedAt,messageCount:r.messages.length}))};}
  async function save(p,body){return serial(p,async()=>{
    const prior=body.id?await read(p,body.id):null;
    if(prior?.deletedAt)fail('该对话已删除，未覆盖已删除的内容。',410);
    if(prior&&(!Number.isInteger(body.version)||body.version!==prior.version))fail('对话已在其他窗口更新，请重新打开后继续。',409);
    if(!prior&&(await rows(p)).filter(r=>!r.deletedAt).length>=LIMIT)fail('对话已达到 100 条，请删除不需要的对话。',409);
    const clean=messages(body.messages),draft=body.draft??'';
    if(typeof draft!=='string'||draft.length>4000)fail('草稿过长。');
    for(const image of clean.flatMap(row=>row.images||[]))if(image.url.startsWith('/api/flow/artifacts/'))await getArtifact(p,image.url.split('/').at(-1));
    const row={id:prior?.id||randomUUID(),title:clip(clean.find(m=>m.role==='user')?.text.replace(/\s+/g,' ').trim(),48)||'新对话',updatedAt:new Date().toISOString(),version:(prior?.version||0)+1,messages:clean,draft,attachments:cleanAttachmentRefs(body.attachments||[])};
    await write(p,row);return publicRow(row);
  });}
  async function remove(p,id){return serial(p,async()=>{const row=await read(p,id);if(!row.deletedAt)await write(p,{...row,deletedAt:new Date().toISOString(),version:row.version+1});return {ok:true};});}
  async function restore(p,id){return serial(p,async()=>{const row=await read(p,id);if(row.deletedAt){if((await rows(p)).filter(r=>!r.deletedAt).length>=LIMIT)fail('对话列表已满，请先删除其他对话。',409);delete row.deletedAt;row.updatedAt=new Date().toISOString();row.version++;await write(p,row);}return publicRow(row);});}
  async function createArtifact(p,{svg,title}){
    const content=sanitizeFlowSVG(svg),id=randomUUID(),dir=path.join(actorDir(p),'images');await fs.mkdir(dir,{recursive:true,mode:0o700});
    await fs.writeFile(path.join(dir,id+'.svg'),content,{mode:0o600,flag:'wx'});
    return {id,url:'/api/flow/artifacts/'+id,title:clip(title,160)||'Flow 图片',alt:clip(title,200)||'Flow 生成的图片'};
  }
  async function getArtifact(p,id){try{return await fs.readFile(path.join(actorDir(p),'images',checkedId(id)+'.svg'),'utf8');}catch(e){if(e.code==='ENOENT')fail('图片不存在或已不可用。',404);throw e;}}
  return {list,get,save,remove,restore,createArtifact,getArtifact};
}
export const flowVisualTool={name:'flow_render_visual',description:'用户要求出图、图表、流程图或示意图时使用。在聊天中直接生成并展示一张矢量图片，返回实际图片链接。必须先查询业务数据再绘制业务图；无数据不得编造。可绘制原创简单插画；不能生成照片。只支持 SVG 图形、路径、文字及渐变，禁止脚本、HTML、外部图片/字体/链接。建议 800×500、浅色背景、蓝灰文字、青蓝紫点缀，文字至少 18px，保留充分边距。',parameters:{type:'object',properties:{title:{type:'string',description:'图片标题'},svg:{type:'string',description:'完整 SVG，包含 xmlns="http://www.w3.org/2000/svg" 和 viewBox；最大 60000 字符。不支持 style 标签或属性、use、image、filter、foreignObject。使用 fill/stroke 等展示属性。'}},required:['title','svg'],additionalProperties:false}};
