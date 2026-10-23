import {cleanAttachmentRefs} from '../flow-attachment-data.js';
import {SaxesParser} from 'saxes';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };
const clip = (value,max=240) => typeof value==='string' ? value.slice(0,max) : '';
export function safeFlowImage(value) {
  return typeof value==='string' && (
    /^\/api\/flow\/artifacts\/[a-f0-9-]{36}$/.test(value) && UUID.test(value.split('/').at(-1)) ||
    /^\/public\/product-images\/[1-9][0-9]?\.jpg$/.test(value)
  ) ? value : null;
}
function safeHref(value) {
  if(typeof value!=='string'||!value.startsWith('/?'))return null;
  let url;try {url=new URL(value,'https://kuraflow.invalid');}catch{return null;}
  if(!['overview','orders','catalogue','stores','documents','tasks'].includes(url.searchParams.get('page')) ||
    [...url.searchParams.keys()].some(key=>!['page','order','store','product','tab','month','from','to','range','demo'].includes(key)))return null;
  return url.pathname+url.search;
}
export function cleanFlowMutation(row) {
  if(!row||typeof row.id!=='string'||!/^flow:[a-f0-9-]{36}:flow_[a-z_]+:[a-f0-9]{64}$/.test(row.id)||!['saved','pending_account'].includes(row.status)||!Number.isSafeInteger(row.revision)||row.revision<0)return null;
  const href=safeHref(row.href);if(!href)return null;
  return {id:row.id,operation:clip(row.operation,64),label:clip(row.label,80),recordId:clip(row.recordId,160),recordLabel:clip(row.recordLabel,160),href,revision:row.revision,status:row.status,replayed:row.replayed===true};
}
export function cleanFlowProposal(row) {
  if(!row||!UUID.test(row.id||'')||!UUID.test(row.requestId||'')||!['pending','saved','cancelled','expired'].includes(row.status))return null;
  return {id:row.id,requestId:row.requestId,operation:clip(row.operation,64),label:clip(row.label,80),recordLabel:clip(row.recordLabel,160),status:row.status,impact:clip(row.impact,500),details:(Array.isArray(row.details)?row.details:[]).slice(0,24).map(field=>({label:clip(field?.label,80),value:clip(field?.value,4000)}))};
}
export function cleanFlowMessages(input) {
  if(!Array.isArray(input)||input.length>120)fail('对话过长，请新建对话。');
  if(JSON.stringify(input).length>512000)fail('对话内容过大，请新建对话。',413);
  return input.map(row=>{
    if(!row||!['user','assistant'].includes(row.role)||typeof row.text!=='string'||row.text.length>40000)fail('对话内容格式不正确。');
    return {role:row.role,text:row.text,
      ...(row.role==='user'&&row.attachments?.length?{attachments:cleanAttachmentRefs(row.attachments)}:{}),...(row.role==='user'&&typeof row.requestId==='string'&&UUID.test(row.requestId)?{requestId:row.requestId}:{}),...(row.role==='assistant'?{
      ...(row.pending===true?{pending:true}:{}),
      ...(Array.isArray(row.mutations)?{mutations:row.mutations.slice(0,6).map(cleanFlowMutation).filter(Boolean)}:{}),
      ...(Array.isArray(row.proposals)?{proposals:row.proposals.slice(0,6).map(cleanFlowProposal).filter(Boolean)}:{}),
      steps:(Array.isArray(row.steps)?row.steps:[]).slice(0,24).flatMap(step=>/^(?:prepare|model|answer|tool-\d{1,2})$/.test(step?.id)&&['running','done','error','stopped'].includes(step.status)?[{id:step.id,label:clip(step.label,80),status:step.status,...(step.detail?{detail:clip(step.detail,160)}:{})}]:[]),
      tools:(Array.isArray(row.tools)?row.tools:[]).slice(0,24).map(tool=>({label:clip(typeof tool==='string'?tool:tool?.label||tool?.name,100)})),
      sources:(Array.isArray(row.sources)?row.sources:[]).slice(0,30).flatMap(source=>{const href=safeHref(source?.href||source?.url);return href?[{label:clip(source.label||source.title,160)||'查看记录',href}]:[];}),
      images:(Array.isArray(row.images)?row.images:[]).slice(0,8).flatMap(image=>{const url=safeFlowImage(image?.url);return url?[{id:clip(image.id,80),url,alt:clip(image.alt||image.title,200),title:clip(image.title,200)}]:[];}),
      ...(row.error?{error:clip(row.error)}:{}),...(row.stopped?{stopped:true}:{})
    }:{})};
  });
}

const NS='http://www.w3.org/2000/svg';
const tags=new Set(['svg','g','path','rect','circle','ellipse','line','polyline','polygon','text','tspan','defs','linearGradient','radialGradient','stop','clipPath','title','desc']);
const attrs=new Set(['xmlns','viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','opacity','fill-opacity','stroke-opacity','transform','id','gradientUnits','gradientTransform','offset','stop-color','stop-opacity','clip-path','text-anchor','dominant-baseline','font-family','font-size','font-weight','letter-spacing','dx','dy','fill-rule','clip-rule','preserveAspectRatio']);
const colors=new Set(['none','transparent','currentColor','white','black','red','blue','green','gray','grey','orange','purple']);
const escapeText=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const escapeAttr=value=>escapeText(value).replace(/"/g,'&quot;').replace(/\r/g,'&#13;').replace(/\n/g,'&#10;').replace(/\t/g,'&#9;');

// Parse XML and rebuild only inert SVG primitives; never pass model markup through.
export function sanitizeFlowSVG(value) {
  if(typeof value!=='string'||value.length>60000||/<!DOCTYPE|<!ENTITY|<\?/i.test(value))fail('图片内容不符合格式，请重新绘制。');
  const parser=new SaxesParser({xmlns:true}),output=[],ids=new Set();
  let depth=0,count=0;
  parser.on('error',()=>fail('图片 SVG 格式不完整，请重新绘制。'));
  parser.on('doctype',()=>fail('图片不允许文档声明。'));
  parser.on('processinginstruction',()=>fail('图片不允许处理指令。'));
  parser.on('opentag',element=>{
    if(++count>1200||++depth>120)fail('图片元素过多，请简化。');
    if(!tags.has(element.local)||element.uri!==NS||element.prefix||depth===1&&element.local!=='svg'||depth!==1&&element.local==='svg')fail('图片包含不支持的元素。');
    const clean={};
    for(const attr of Object.values(element.attributes)) {
      const {name,value:v}=attr;
      if(!attrs.has(name)||name!=='xmlns'&&(attr.prefix||attr.uri)||v.length>10000||/[\u0000-\u0008]/.test(v))fail('图片包含不支持的属性。');
      if(name==='xmlns'&&(depth!==1||v!==NS))fail('图片命名空间不正确。');
      if(name==='id') {if(!/^[a-zA-Z][\w-]{0,50}$/.test(v)||ids.has(v))fail('图片元素标识不正确。');ids.add(v);}
      if(['fill','stroke','stop-color'].includes(name)&&!colors.has(v)&&!/^#[\da-fA-F]{3,8}$/.test(v)&&!/^rgba?\([\d.,%\s]+\)$/.test(v)&&!/^url\(#[a-zA-Z][\w-]{0,50}\)$/.test(v))fail('图片颜色格式不正确。');
      if(name==='clip-path'&&!/^url\(#[a-zA-Z][\w-]{0,50}\)$/.test(v))fail('图片剪裁格式不正确。');
      if(name==='font-family'&&!/^[a-zA-Z\s,\-'\u4e00-\u9fff]{1,120}$/.test(v))fail('图片字体格式不正确。');
      if(name!=='xmlns'&&/(?:javascript|https?:|data:|@import|expression)/i.test(v))fail('图片不允许外部资源。');
      clean[name]=v;
    }
    if(depth===1) {
      const viewBox=(clean.viewBox||'0 0 800 500').trim().split(/[ ,]+/).map(Number);
      if(viewBox.length!==4||viewBox.some(n=>!Number.isFinite(n))||viewBox[2]<100||viewBox[3]<80||viewBox[2]>2400||viewBox[3]>2400)fail('图片尺寸需在 2400 像素以内。');
      clean.viewBox=viewBox.join(' ');clean.width=String(viewBox[2]);clean.height=String(viewBox[3]);clean['font-family']='Arial, Noto Sans SC, sans-serif';
    }
    output.push('<'+element.local+Object.entries(clean).map(([key,v])=>' '+key+'="'+escapeAttr(v)+'"').join('')+'>');
  });
  parser.on('closetag',element=>{output.push('</'+element.local+'>');depth--;});
  parser.on('text',value=>{if(depth)output.push(escapeText(value));});
  parser.on('cdata',value=>{if(depth)output.push(escapeText(value));});
  try {parser.write(value).close();}catch(error){if(error.status)throw error;fail('图片 SVG 格式不完整，请重新绘制。');}
  if(!count||depth)fail('图片需要有效的 SVG 根元素。');
  return output.join('');
}

export const flowVisualTool={name:'flow_render_visual',description:'用户要求出图、图表、流程图或示意图时使用。在聊天中直接生成并展示一张矢量图片，返回实际图片链接。必须先查询业务数据再绘制业务图；无数据不得编造。可绘制原创简单插画；不能生成照片。只支持 SVG 图形、路径、文字及渐变，禁止脚本、HTML、外部图片/字体/链接。建议 800×500、浅色背景、蓝灰文字、青蓝紫点缀，文字至少 18px，保留充分边距。',parameters:{type:'object',properties:{title:{type:'string',description:'图片标题'},svg:{type:'string',description:'完整 SVG，包含 xmlns="http://www.w3.org/2000/svg" 和 viewBox；最大 60000 字符。不支持 style 标签或属性、use、image、filter、foreignObject。使用 fill/stroke 等展示属性。'}},required:['title','svg'],additionalProperties:false}};
