import messages from './messages.js';
export const LANGUAGES=Object.freeze([{code:'zh',label:'中文'},{code:'ja',label:'日本語'},{code:'en',label:'English'},{code:'vi',label:'Tiếng Việt'}]);
const tags={zh:'zh-CN',ja:'ja-JP',en:'en-US',vi:'vi-VN'};
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let language='zh',enabled=true,scope='login',initialized=false,refreshPolicy=null;
const units=new Map(),byKey=new Map(),textBindings=new Map();let serial=0;
export function setI18nText(element,read,property='textContent'){if(!element)return '';let bindings=textBindings.get(element);if(!bindings){bindings=new Map();textBindings.set(element,bindings);}const value=read();bindings.set(property,{read,last:value});return element[property]=value;}
const normalize=value=>LANGUAGES.some(row=>row.code===value)?value:'zh';
export const getLanguage=()=>language;
export const getLocale=()=>tags[language];
export const multilingualEnabled=()=>enabled;
function translated(key){const entry=messages[String(key)];return language==='zh'||!entry?String(key):entry[{ja:0,en:1,vi:2}[language]]||String(key);}
export const mp=(key,params=[])=>({__uiMessage:String(key),params});
export const mj=parts=>({__uiParts:parts});
export const me=value=>({__uiEscape:value});
function parameter(value,html){
 if(value&&typeof value==='object'){
  if('__uiMessage' in value)return interpolate(translated(value.__uiMessage),value.params,html);
  if('__uiParts' in value)return value.__uiParts.map(v=>parameter(v,html)).join('');
  if('__uiEscape' in value)return esc(parameter(value.__uiEscape,false));
 }
 return String(value??'');
}
function interpolate(text,params,escapeParts=false){return text.split(/(\{\d+\})/g).map(part=>/^\{\d+\}$/.test(part)?parameter(params[Number(part.slice(1,-1))],escapeParts):escapeParts?esc(part):part).join('');}
export function t(key,params=[]){return interpolate(translated(key),params);}
function register(key,params){const clean=params.map(value=>value&&typeof value==='object'&&('__uiMessage' in value||'__uiParts' in value||'__uiEscape' in value)?value:String(value??'')),signature=JSON.stringify([key,clean]);if(byKey.has(signature))return byKey.get(signature);const id=String(++serial);units.set(id,{key:String(key),params:clean});byKey.set(signature,id);return id;}
export function tx(key,params=[]){if(typeof key==='string'&&key.includes('<!--kf-i18n:'))return key;const id=register(key,params);return `<!--kf-i18n:${id}-->${interpolate(translated(key),params,true)}<!--/kf-i18n:${id}-->`;}
export function ta(attribute,key,params=[]){if(!['title','placeholder','aria-label','alt'].includes(attribute))throw Error('Invalid translation attribute');const id=register(key,params);return `${attribute}="${interpolate(translated(key),params,true)}" data-i18n-${attribute}="${id}"`;}
export function translatedError(message){
 const input=String(message||'');if(messages[input])return t(input);
 for(const [key]of Object.entries(messages)){if(!/\{\d+\}/.test(key))continue;const parts=key.split(/(\{\d+\})/g),indices=[];const pattern=parts.map(part=>/^\{\d+\}$/.test(part)?(indices.push(Number(part.slice(1,-1))),'([\\s\\S]*?)'):part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('');const match=input.match(new RegExp('^'+pattern+'$'));if(match){const params=[];indices.forEach((n,i)=>params[n]=match[i+1]);return t(key,params);}}
 return input;
}
export function applyTranslations(root=document){
 for(const [element,bindings]of textBindings){if(!element.isConnected&&element!==document){textBindings.delete(element);continue;}for(const [property,binding]of bindings){if(element[property]!==binding.last){bindings.delete(property);continue;}binding.last=binding.read();element[property]=binding.last;}}
 const walker=document.createTreeWalker(root,128);while(walker.nextNode()){
  const start=walker.currentNode;if(!/^kf-i18n:\d+$/.test(start.nodeValue))continue;
  const id=start.nodeValue.slice(8),unit=units.get(id);if(!unit)continue;let end=start.nextSibling;
  while(end&&!(end.nodeType===8&&end.nodeValue==='/kf-i18n:'+id))end=end.nextSibling;
  if(!end)continue;const range=document.createRange();range.setStartAfter(start);range.setEndBefore(end);range.deleteContents();range.insertNode(range.createContextualFragment(interpolate(translated(unit.key),unit.params,true)));
 }
 for(const attr of ['title','placeholder','aria-label','alt'])root.querySelectorAll?.(`[data-i18n-${attr}]`).forEach(el=>{const unit=units.get(el.getAttribute('data-i18n-'+attr));if(unit)el.setAttribute(attr,interpolate(translated(unit.key),unit.params).replace(/&(?:amp|lt|gt|quot|#39);/g,v=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&#39;':"'"}[v])));});
}
function readPreference(){try{return normalize(localStorage.getItem('kuraflow-language:'+scope)||localStorage.getItem('kuraflow-language:last'));}catch{return 'zh';}}
function closeLanguageMenus(except=null){document.querySelectorAll('[data-language-menu]').forEach(menu=>{if(menu===except)return;menu.hidden=true;const button=menu.closest('.language-picker')?.querySelector('[data-language-trigger]');button?.setAttribute('aria-expanded','false');});}
function syncSelectors(){
 document.documentElement.lang=tags[language];document.documentElement.dataset.uiLanguage=language;
 document.querySelectorAll('.language-picker').forEach(control=>{
  const button=control.querySelector('[data-language-trigger]'),menu=control.querySelector('[data-language-menu]');
  control.classList.toggle('is-disabled',!enabled);control.title=enabled?'':t('多语言功能未开启');
  if(button){button.disabled=!enabled;button.setAttribute('aria-label',t('界面语言'));button.title=enabled?t('界面语言'):t('多语言功能未开启');}
  menu?.querySelectorAll('[data-language-value]').forEach(option=>{const selected=option.dataset.languageValue===language;option.classList.toggle('is-selected',selected);option.setAttribute('aria-checked',String(selected));});
 });
}
let changing=false;
export function setLanguage(value,{persist=true}={}){const next=enabled?normalize(value):'zh';if(next===language){document.documentElement.lang=tags[next];return;}language=next;if(persist)try{localStorage.setItem('kuraflow-language:'+scope,next);localStorage.setItem('kuraflow-language:last',next);}catch{}applyTranslations();changing=true;syncSelectors();changing=false;document.dispatchEvent(new CustomEvent('kuraflow:language-change',{detail:{language}}));}
export function languagePicker(){return `<div class="language-picker ${enabled?'':'is-disabled'}" title="${esc(enabled?'':t('多语言功能未开启'))}"><button type="button" class="icon-button topbar-tool language-trigger" data-language-trigger aria-haspopup="menu" aria-expanded="false" aria-label="${esc(t('界面语言'))}" title="${esc(enabled?t('界面语言'):t('多语言功能未开启'))}" ${enabled?'':'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/></svg></button><div class="language-menu" data-language-menu role="menu" aria-label="${esc(t('界面语言'))}" hidden>${LANGUAGES.map(row=>`<button type="button" role="menuitemradio" aria-checked="${row.code===language}" class="${row.code===language?'is-selected':''}" data-language-value="${row.code}"><span>${row.label}</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg></button>`).join('')}</div></div>`;}
export function configureLanguage({portal='kitchen',tenantId='',userId='',multilingualEnabled=true,policyLoader=null}={}){scope=[portal,tenantId,userId].join(':');enabled=multilingualEnabled;refreshPolicy=policyLoader;language=enabled?readPreference():'zh';document.documentElement.lang=tags[language];document.documentElement.dataset.uiLanguage=language;
 if(!initialized){initialized=true;
  document.addEventListener('click',event=>{const trigger=event.target.closest?.('[data-language-trigger]'),choice=event.target.closest?.('[data-language-value]');if(trigger){const menu=trigger.closest('.language-picker').querySelector('[data-language-menu]'),opening=menu.hidden;closeLanguageMenus(menu);menu.hidden=!opening;trigger.setAttribute('aria-expanded',String(opening));if(opening)menu.querySelector('[aria-checked="true"]')?.focus();return;}if(choice){setLanguage(choice.dataset.languageValue);closeLanguageMenus();return;}if(!event.target.closest?.('.language-picker'))closeLanguageMenus();});
  document.addEventListener('keydown',event=>{const menu=event.target.closest?.('[data-language-menu]');if(event.key==='Escape'){closeLanguageMenus();menu?.closest('.language-picker')?.querySelector('[data-language-trigger]')?.focus();}if(menu&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const options=[...menu.querySelectorAll('[data-language-value]')],index=options.indexOf(document.activeElement),next=(index+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next]?.focus();}});
  window.addEventListener('focus',refreshLanguagePolicy);setInterval(()=>{if(document.visibilityState!=='hidden')refreshLanguagePolicy();},30000);
 }
}
export async function refreshLanguagePolicy(){if(!refreshPolicy)return;try{const policy=await refreshPolicy();window.__KURAFLOW_UI_FEATURES__=policy;document.dispatchEvent(new CustomEvent('kuraflow:ui-features',{detail:policy}));const next=policy.multilingualEnabled===true;if(next!==enabled){enabled=next;setLanguage(enabled?readPreference():'zh',{persist:false});changing=true;syncSelectors();changing=false;document.dispatchEvent(new CustomEvent('kuraflow:language-policy',{detail:{enabled}}));}}catch{}}
