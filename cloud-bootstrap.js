import {hydrateMaterialSources} from './cloud-seed.js';
const app=document.getElementById('app'),query=new URLSearchParams(location.search);
const requested=query.get('login')||query.get('portal');
const portal=requested==='platform'?'platform':requested==='store'||query.get('view')==='client'?'store':'kitchen';
let tab=query.get('tab')==='admin'?'admin':'owner';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function request(path,body){const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});let data;try{data=await response.json();}catch{throw new Error('服务器响应未完整接收，请重试。');}if(!response.ok)throw new Error(data.error||'操作未完成。');return data;}
function shell(contents){app.innerHTML=`<main class="cloud-entry"><section class="cloud-login section-card accounts-login"><div class="cloud-wordmark">倉流 <span>KURAFLOW</span></div>${contents}</section></main>`;}
function login(message='',value=''){
 const platform=portal==='platform',master=tab==='owner',title=platform?'平台登录':portal==='kitchen'?'厨房端登录':'门店端登录';
 shell(`<h1>${title}</h1>${platform?'':`<div class="tabs account-login-tabs" role="tablist" aria-label="登录身份"><button type="button" role="tab" aria-selected="${master}" class="tab ${master?'active':''}" data-login-tab="owner">负责人登录</button><button type="button" role="tab" aria-selected="${!master}" class="tab ${!master?'active':''}" data-login-tab="admin">管理员登录</button></div>`}<form id="account-login" method="post">${platform?`<div class="field"><label for="login-key">平台密钥</label><input class="input" id="login-key" name="key" type="password" autocomplete="current-password" placeholder="粘贴平台密钥" required maxlength="256"></div>`:master?`<div class="field"><label for="login-code">负责人码</label><input class="input account-master-input" id="login-code" name="code" value="${esc(value)}" autocomplete="off" spellcheck="false" autocapitalize="characters" placeholder="XXXX-XXXX-XXXX-XXXX" required maxlength="64"></div>`:`<div class="field"><label for="login-username">账号名</label><input class="input" id="login-username" name="username" value="${esc(value)}" autocomplete="username" required maxlength="32"></div><div class="field"><label for="login-password">密码</label><input class="input" id="login-password" name="password" type="password" autocomplete="current-password" required maxlength="128"></div>`}<div class="cloud-login-error" role="alert">${esc(message)}</div><button class="btn btn-primary cloud-login-button" type="submit">登录</button></form>${!platform?`<p class="form-hint">${master?'使用 16 位负责人码，无需额外密码。':'账号由负责人创建；忘记密码请联系负责人。'}</p>`:''}<nav class="accounts-login-links" aria-label="切换登录入口">${[['kitchen','厨房端'],['store','门店端']].filter(([key])=>key!==portal).map(([key,label])=>`<a class="text-button" href="/?login=${key}">${label}</a>`).join('')}</nav>`);
 document.querySelectorAll('[data-login-tab]').forEach(button=>button.addEventListener('click',()=>{tab=button.dataset.loginTab;history.replaceState(null,'','?'+new URLSearchParams({login:portal,tab}));login();}));
 const form=document.getElementById('account-login');
 form.addEventListener('submit',async event=>{event.preventDefault();const submit=form.querySelector('[type=submit]');if(submit.disabled)return;submit.disabled=true;try{const values=Object.fromEntries(new FormData(form));await request(platform?'/api/accounts/platform-login':master?'/api/accounts/master-login':'/api/accounts/login',{...values,portal});location.replace(platform?'/?login=platform':portal==='store'?'/?view=client':'/?page=overview');}catch(error){login(error.message,form.elements.namedItem(master?'code':'username')?.value||'');}});
}
async function enter(principal){
 shell('<h1>正在载入工作台</h1>');
 if(principal.role==='platform'){window.__KURAFLOW_ACCOUNT_PRINCIPAL__=principal;await import('./platform-app.js');return;}
 const session=await request('/api/state');if(!session.principal||!session.state)throw new Error('登录状态不完整。');
 if(session.principal.role==='admin')hydrateMaterialSources(await request('/api/admin/materials'));else hydrateMaterialSources({company:{name:session.state.settings?.companyName||'倉流'}});
 window.__KURAFLOW_SESSION__=session;await import('./app.js');
}
shell('<h1>正在连接倉流</h1>');
try{const session=await request('/api/accounts/session'),expected={platform:'platform',kitchen:'admin',store:'store'}[portal];if(session.authenticated&&(!requested&&!query.has('view')||session.principal.role===expected))await enter(session.principal);else login();}catch(error){login(error.message||'网络连接失败，请重试。');}
