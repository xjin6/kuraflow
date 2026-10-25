import fs from 'node:fs/promises';import path from 'node:path';import {parse} from 'acorn';import {parseFragment} from 'parse5';
const root=process.cwd(),apply=process.argv.includes('--apply'),only=process.argv.find(a=>a.startsWith('--file='))?.slice(7),skipAccounts=process.argv.includes('--skip-accounts');
const HAN=/[\u3400-\u9fff]/, inventory=new Map();
const add=(key,file)=>{if(!HAN.test(key)||key.length>700||/^(?:SELECT|INSERT|UPDATE|DELETE|CREATE)\b/i.test(key))return;const list=inventory.get(key)||new Set();list.add(file);inventory.set(key,list);};
async function walk(dir){const result=[];for(const d of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,d.name);if(d.isDirectory())result.push(...await walk(p));else if(p.endsWith('.js'))result.push(p);}return result;}
const files=only?[path.resolve(only)]:[...await walk('src/app'),...await walk('src/features'),...await walk('src/ui')];
const helperArgs={button:[0],heading:[0],titleHeading:[0],managementHeading:[],field:[0],statCard:[0,2],emptyState:[0,1],modal:[0,1,2]};
const q=JSON.stringify,escapeTemplate=s=>s.replace(/\\/g,'\\\\').replace(/`/g,'\\`').replace(/\$\{/g,'\\${');
for(const input of files){const file=path.relative(root,path.resolve(input)),source=await fs.readFile(input,'utf8');if(file.endsWith('order-pdf.js'))continue;if(apply&&/from ['"][^'"]*i18n\/index\.js/.test(source))throw Error('Already localized: '+file);const ast=parse(source,{ecmaVersion:'latest',sourceType:'module'});let uses=false;
 function collect(node){if(!node||typeof node!=='object')return;if(node.type==='Literal'&&typeof node.value==='string')add(node.value,file);if(node.type==='TemplateLiteral'){let key=node.quasis.map((a,i)=>(a.value.cooked??a.value.raw)+(i<node.expressions.length?`{${i}}`:'')).join('');if(!key.includes('<'))add(key,file);}for(const [k,v]of Object.entries(node))if(!['start','end','loc'].includes(k)){if(Array.isArray(v))v.forEach(collect);else if(v&&typeof v==='object')collect(v);}}
 collect(ast);
 function call(name,key,args=[]){uses=true;add(key,file);return `${name}(${q(key)}${args.length?', ['+args.join(', ')+']':''})`;}
 function display(node,kind='tx'){
  if(node.type==='Literal'&&typeof node.value==='string'&&HAN.test(node.value)&&!node.value.includes('<'))return call(kind,node.value);
  if(node.type==='TemplateLiteral'&&!node.quasis.some(x=>(x.value.cooked??'').includes('<'))){const key=node.quasis.map((a,i)=>(a.value.cooked??a.value.raw)+(i<node.expressions.length?`{${i}}`:'')).join('');if(HAN.test(key))return call(kind,key,node.expressions.map(n=>render(n)));}
  if(node.type==='ConditionalExpression')return `(${render(node.test)} ? ${display(node.consequent,kind)} : ${display(node.alternate,kind)})`;
  if(node.type==='LogicalExpression')return `(${render(node.left)} ${node.operator} ${display(node.right,kind)})`;
  if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&['esc','escape'].includes(node.callee.name)&&node.arguments.length===1){const a=node.arguments[0];return node.callee.name+'('+display(a,'t')+')';}
  return render(node);
 }
 function html(text,expressions=[]){
  const fragment=parseFragment(text,{sourceCodeLocationInfo:true}),changes=[];const tokens=/__KFEXPR_(\d+)__/g;
  function translateRange(value,start,end,attr){
   const parts=[];let cursor=0,key='',match;tokens.lastIndex=0;
   while((match=tokens.exec(value))){key+=value.slice(cursor,match.index)+`{${parts.length}}`;parts.push(Number(match[1]));cursor=match.index+match[0].length;}key+=value.slice(cursor);
   if(!HAN.test(key))return;
   const leading=attr?'':key.match(/^\s*/)[0],trailing=attr?'':key.match(/\s*$/)[0];key=key.slice(leading.length,trailing.length?key.length-trailing.length:undefined);if(!key)return;
   const args=parts.map(i=>render(expressions[i]));const code=attr?`ta(${q(attr)}, ${q(key)}${args.length?', ['+args.join(', ')+']':''})`:call('tx',key,args);if(attr){uses=true;add(key,file);}changes.push({start,end,replacement:leading+'__KFINJECT_'+injections.push(code)+'__'+trailing});
  }
  const injections=[];
  function visit(node){
   const location=node.sourceCodeLocation;
   if(node.nodeName==='#text'&&location)translateRange(node.value,location.startOffset,location.endOffset);
   for(const attr of node.attrs||[]){if(!['title','placeholder','aria-label','alt'].includes(attr.name)||!location?.attrs?.[attr.name])continue;const loc=location.attrs[attr.name];translateRange(attr.value,loc.startOffset,loc.endOffset,attr.name);}
   for(const child of node.childNodes||[])visit(child);if(node.content)visit(node.content);
  }
  visit(fragment);
  // Translate literal/conditional display slots while leaving raw data slots alone.
  const used=new Set();for(const change of changes)for(const m of text.slice(change.start,change.end).matchAll(tokens))used.add(Number(m[1]));
  const slotMode=new Map();function modes(node){if(node.nodeName==='#text')for(const m of (node.value||'').matchAll(tokens))slotMode.set(Number(m[1]),'tx');for(const a of node.attrs||[])if(['title','placeholder','aria-label','alt'].includes(a.name))for(const m of a.value.matchAll(tokens))slotMode.set(Number(m[1]),'t');for(const c of node.childNodes||[])modes(c);if(node.content)modes(node.content);}modes(fragment);
  for(const change of changes.sort((a,b)=>b.start-a.start))text=text.slice(0,change.start)+change.replacement+text.slice(change.end);
  const out=text.split(/(__KFEXPR_\d+__|__KFINJECT_\d+__)/g).map(part=>{let m=part.match(/^__KFEXPR_(\d+)__$/);if(m)return '${'+(slotMode.has(+m[1])?display(expressions[+m[1]],slotMode.get(+m[1])):render(expressions[+m[1]]))+'}';m=part.match(/^__KFINJECT_(\d+)__$/);return m?'${'+injections[+m[1]-1]+'}':escapeTemplate(part);}).join('');
  return '`'+out+'`';
 }
 function generic(node){const children=[];for(const [key,value]of Object.entries(node)){if(['start','end','loc'].includes(key))continue;if(Array.isArray(value))for(const x of value)if(x?.type)children.push(x);else{}else if(value?.type)children.push(value);}
  const direct=children.filter((x,i)=>!children.some((y,j)=>j!==i&&y.start<=x.start&&y.end>=x.end&&(y.start<x.start||y.end>x.end)));let out=source.slice(node.start,node.end);for(const child of direct.sort((a,b)=>b.start-a.start))out=out.slice(0,child.start-node.start)+render(child)+out.slice(child.end-node.start);return out;
 }
 function render(node){
  if(!node)return '';
  if(node.type==='TemplateLiteral'){const text=node.quasis.map((a,i)=>(a.value.cooked??a.value.raw)+(i<node.expressions.length?`__KFEXPR_${i}__`:'')).join('');if(/<[A-Za-z!/]/.test(text))return html(text,node.expressions);return generic(node);}
  if(node.type==='Literal'&&typeof node.value==='string'&&/<[A-Za-z!/]/.test(node.value)&&HAN.test(node.value)&&node.value.trimStart().startsWith('<'))return html(node.value);
  if(node.type==='CallExpression'&&node.callee.type==='Identifier'&&helperArgs[node.callee.name]){let out=source.slice(node.start,node.end);for(let i=node.arguments.length-1;i>=0;i--){const a=node.arguments[i];const value=helperArgs[node.callee.name].includes(i)?display(a):render(a);out=out.slice(0,a.start-node.start)+value+out.slice(a.end-node.start);}return out;}
  if(node.type==='AssignmentExpression'&&node.operator==='='&&node.left.type==='MemberExpression'&&!node.left.computed&&['textContent','innerText','placeholder','title'].includes(node.left.property.name)&&HAN.test(source.slice(node.right.start,node.right.end))){uses=true;return `setI18nText(${render(node.left.object)}, () => ${display(node.right,'t')}, ${q(node.left.property.name)})`;}
  if(node.type==='BinaryExpression'&&['===','!==','==','!='].includes(node.operator)&&node.left.type==='MemberExpression'&&['textContent','innerText'].includes(node.left.property?.name))return `${render(node.left)} ${node.operator} ${display(node.right,'t')}`;
  return generic(node);
 }
 const output=render(ast);if(apply&&uses&&!(skipAccounts&&file==='src/features/accounts/accounts-ui.js')){await fs.mkdir('private-preview/i18n/original/'+path.dirname(file),{recursive:true});await fs.writeFile('private-preview/i18n/original/'+file,source);let relative=path.relative(path.dirname(file),'src/i18n/index.js').split(path.sep).join('/');if(!relative.startsWith('.'))relative='./'+relative;await fs.writeFile(file,`import {t, tx, ta, setI18nText} from ${q(relative)};\n`+output);}
}
await fs.mkdir('private-preview/i18n',{recursive:true});if(only){try{for(const row of JSON.parse(await fs.readFile('private-preview/i18n/source-messages.json','utf8')))for(const file of row.files)add(row.key,file);}catch{}}await fs.writeFile('private-preview/i18n/source-messages.json',JSON.stringify([...inventory].filter(([k])=>!k.includes('<')&&!k.includes('SELECT ')).map(([key,files])=>({key,files:[...files]})),null,2));console.log(JSON.stringify({keys:inventory.size,files:files.length,applied:apply}));
