import {FLOW_ATTACHMENT_ACCEPT,cleanAttachmentRefs,attachmentId} from '../../shared/flow-attachment-data.js';
const FLOW_ICON = '<img class="flow-mark" src="/flow-mark.svg" width="24" height="24" alt="" aria-hidden="true" draggable="false">';
const GLYPHS = {
  attach:'<path d="m21 11-9 9a6 6 0 0 1-8-8L15 1a4 4 0 0 1 6 6L10 18a2 2 0 0 1-3-3L17 5"/>',
  close:'<path d="m6 6 12 12M18 6 6 18"/>', plus:'<path d="M12 5v14M5 12h14"/>',
  send:'<path d="M12 19V5m-6 6 6-6 6 6"/>', stop:'<rect x="6" y="6" width="12" height="12" rx="2"/>',
  settings:'<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  arrow:'<path d="M5 12h14m-5-5 5 5-5 5"/>', copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V4H4v13h4"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>', check:'<path d="m5 12 4 4L19 6"/>',
  history:'<path d="M4 7h16M4 12h12M4 17h8"/>', trash:'<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  refresh:'<path d="M20 7v5h-5M4 17v-5h5M6.1 6a8 8 0 0 1 13 3M4.9 15a8 8 0 0 0 13 3"/>',
  expand:'<path d="M14 4h6v6M20 4l-8 8M10 4H4v16h16v-6"/>',
};
const glyph = name => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[name] || GLYPHS.arrow}</svg>`;
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Model output never becomes arbitrary HTML, navigation or network requests.
export function safeFlowHref(value) {
  if (typeof value !== 'string' || !value.startsWith('/?')) return null;
  const url = new URL(value, 'https://kuraflow.invalid');
  const pages = new Set(['overview','orders','catalogue','stores','documents','tasks']);
  const keys = new Set(['page','order','store','product','tab','month','from','to','range','demo']);
  if (!pages.has(url.searchParams.get('page')) || [...url.searchParams.keys()].some(key => !keys.has(key))) return null;
  return url.pathname + url.search;
}
export function safeFlowImageHref(value) {
  if (typeof value !== 'string') return null;
  return /^\/api\/flow\/artifacts\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || /^\/public\/product-images\/\d+\.jpg$/.test(value) ? value : null;
}
export function formatFlowText(value) {
  const plain = text => escape(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const inline = text => text.split(/(\[[^\]\n]+\]\(\s*\/\?[^)\n]+\s*\))/g).map(part => {
    const match=/^\[([^\]]+)\]\(\s*(\/\?[^)]+?)\s*\)$/.exec(part), href=match&&safeFlowHref(match[2]);
    return href ? `<a class="flow-answer-link" href="${escape(href)}">${plain(match[1])}</a>` : plain(part);
  }).join('');
  let result = '', list = null;
  const lines=String(value||'').split('\n');
  const cells=line=>line.trim().replace(/^\|/,'').replace(/\|$/,'').split(/(?<!\\)\|/).map(cell=>cell.trim().replace(/\\\|/g,'|'));
  for (let position=0;position<lines.length;position++) {
    const line=lines[position],header=cells(line),divider=lines[position+1]&&cells(lines[position+1]);
    if(line.includes('|')&&header.length>=2&&header.length<=12&&divider?.length===header.length&&divider.every(cell=>/^:?-{3,}:?$/.test(cell))){
      if(list){result+=`</${list}>`;list=null;}
      result+='<div class="flow-answer-table"><table><thead><tr>'+header.map(cell=>'<th>'+inline(cell)+'</th>').join('')+'</tr></thead><tbody>';position++;
      while(position+1<lines.length&&lines[position+1].includes('|')&&cells(lines[position+1]).length===header.length){position++;result+='<tr>'+cells(lines[position]).map(cell=>'<td>'+inline(cell)+'</td>').join('')+'</tr>';}
      result+='</tbody></table></div>';continue;
    }
    const bullet = /^\s*([-*]|\d+[.)、])\s+(.+)$/.exec(line), next = bullet ? (/^\d/.test(bullet[1]) ? 'ol' : 'ul') : null;
    if (list && list !== next) { result += `</${list}>`; list = null; }
    if (next && !list) { list = next; result += `<${list}>`; }
    if (bullet) result += `<li>${inline(bullet[2])}</li>`;
    else if (/^#{1,4}\s/.test(line)) result += `<h3>${inline(line.replace(/^#{1,4}\s+/, ''))}</h3>`;
    else if (line.trim()) result += `<p>${inline(line)}</p>`;
  }
  return result + (list ? `</${list}>` : '');
}
function imagesFrom(message) {
  const images = [], seen = new Set();
  const add = image => {
    const url = safeFlowImageHref(image?.url);
    if (!url || seen.has(url) || images.length >= 8) return;
    seen.add(url); images.push({url,alt:String(image.alt || image.title || 'Flow 生成的图片').slice(0,300),title:String(image.title || '').slice(0,160)});
  };
  const text = String(message.text || '').replace(/!\[([^\]\n]*)\]\(\s*([^\s)]+)(?:\s+"([^"\n]*)")?\s*\)/g, (whole,alt,url,title) => {
    if (!safeFlowImageHref(url)) return whole;
    add({url,alt,title}); return '';
  });
  for (const image of message.images || []) add(image);
  return {text,images};
}
function renderImage(image) {
  return `<figure class="flow-image"><a class="flow-image-preview" href="${escape(image.url)}" target="_blank" rel="noopener noreferrer" aria-label="查看大图：${escape(image.alt)}"><span class="flow-image-state" role="status">图片加载中…</span><img src="${escape(image.url)}" alt="${escape(image.alt)}" loading="lazy" decoding="async" data-flow-image></a><figcaption><span>${escape(image.title || image.alt)}</span><a href="${escape(image.url)}" target="_blank" rel="noopener noreferrer">查看大图 ${glyph('expand')}</a></figcaption></figure>`;
}
const newConversation = value => ({id:value?.id || null, version:value?.version,
  messages:Array.isArray(value?.messages)?value.messages.map(message=>message.role==='assistant'&&message.pending?{...message,pending:false,error:message.error||'上次处理已中断，请核对保存结果。'}:message):[],
  draft:value?.draft || '', attachments:cleanAttachmentRefs(value?.attachments||[]), revision:0, savedRevision:0, error:'', saving:false, queue:Promise.resolve()});

export function createFlowUI({enabled = true, initialStatus = null, getContext = () => ({}), onOpen = () => {}, onBusinessChange = () => {}, endpoint = '/api/flow', principal = {}, onNavigate = null, request: requestOverride, send: sendOverride, prepareAttachment} = {}) {
  if (!enabled) return {launcher: () => '', sync() {}, open() {}, destroy() {}};
  const localPreview=location.protocol==='http:'&&['localhost','127.0.0.1'].includes(location.hostname);
  const root = document.createElement('div'); root.id = 'flow-root'; document.body.append(root);
  let opened=false, busy=false, controller=null, returnFocus=null, destroyed=false, generation=0, resolving=null;
  let status=initialStatus,statusError='',statusFlight=null,policyTimer=null,pendingOpen=false;
  let current=newConversation(), conversations=[], historyOpen=false, historyLoading=false, historyError='', transitioning=false, deleted=null, draftTimer=null, historyRequest=0, historyMutation=0;
  let pendingUploads=[],attachmentError='',attachmentPreview=null,selectionBusy=false;
  const attachmentBusy=()=>selectionBusy||pendingUploads.some(row=>['reading','uploading'].includes(row.status));
  const historyChanges = new Map();
  const notifiedMutations = new Set();
  const listeners = new AbortController();
  const request = requestOverride || (async (route, body) => {
    const response = await fetch(endpoint + route, {credentials:'same-origin',cache:'no-store',...(body === undefined ? {} : {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    let data; try { data = await response.json(); } catch { throw new Error('Flow 暂时无法连接，请稍后重试。'); }
    if (!response.ok) { const error=new Error(data.error || 'Flow 暂时无法连接，请稍后重试。'); error.status=response.status; throw error; }
    return data;
  });
  const entitled = () => status?.enabled===true;
  const connected = () => entitled() && (status?.available ?? status?.connected)===true;
  const launchLabel = () => !status?'正在确认 Flow 状态':!entitled()?'Flow 已停用':'打开 Flow 助手';
  const contextLabel = () => getContext().label || ({overview:'经营概览',orders:'订单履约',catalogue:'商品管理',stores:'门店管理',documents:'月结与统计',team:'员工管理'}[getContext().page]) || '管理端';
  const statusLabel = () => connected() ? (status.modelName || status.model || 'Flow') : entitled()?'暂不可用':'未开通';
  const title = conversation => conversation.messages.find(message=>message.role==='user')?.text.slice(0,42) || conversation.draft.slice(0,42) || '新对话';
  const touch = (conversation=current) => {conversation.revision++;};
  const promptChoices = () => {
    if (getContext().page === 'orders') return ['哪些订单还没有配齐？','汇总今天需要配送的订单','检查订单中的异常备注'];
    if (getContext().page === 'catalogue') return ['哪些商品库存不足？','查找还没有报价的商品','汇总各类商品与库存'];
    if (getContext().page === 'stores') return ['汇总目前的合作门店','哪些门店最近有订单？','查看门店的待结算订单'];
    return ['今天有哪些订单需要处理？','这个月的营业情况怎么样？','哪些商品需要补货？'];
  };
  function launcher({compact=false}={}) {
    return `<button type="button" class="${compact?'icon-button flow-launcher-compact':'flow-launcher'}" data-flow-action="open" aria-label="${launchLabel()}" title="${launchLabel()}" ${entitled()?'':'disabled'} aria-controls="flow-panel" aria-expanded="${opened}">${FLOW_ICON}${compact?'':'<span>Flow</span><span class="flow-launcher-key" aria-hidden="true">AI</span>'}</button>`;
  }
  function sync() {
    document.querySelectorAll('[data-flow-action="open"]').forEach(button=>{button.setAttribute('aria-expanded',String(opened));button.disabled=!entitled();button.setAttribute('aria-label',launchLabel());button.title=launchLabel();button.classList.toggle('is-unavailable',!entitled());});
    const context=root.querySelector('.flow-current-context span'); if(context)context.textContent=contextLabel();
    if (!current.messages.length && opened) renderMessages();
  }
  function renderShell() {
    root.innerHTML = `<aside id="flow-panel" class="flow-panel" aria-label="Flow 助手" role="dialog" ${opened?'':'hidden'}><header class="flow-header"><div class="flow-title">${FLOW_ICON}<h2>Flow</h2><span class="flow-preview-tag">${localPreview?'预览':'Beta'}</span></div><div class="flow-header-actions"><button type="button" class="icon-button" data-flow-action="new" aria-label="新对话" title="新对话">${glyph('plus')}</button><button type="button" class="icon-button" data-flow-action="close" aria-label="关闭 Flow" title="关闭">${glyph('close')}</button></div></header><div class="flow-context-row"><div class="flow-current-context">${glyph('chevron')}<span>${escape(contextLabel())}</span></div><span class="flow-status"><i></i><span>${escape(statusLabel())}</span></span></div><div class="flow-access-note" role="status" hidden></div><div class="flow-thread-bar"><span class="flow-thread-title"></span><button type="button" data-flow-action="history" aria-controls="flow-history" aria-expanded="${historyOpen}">${glyph('history')}<span>对话列表</span></button></div><section id="flow-history" class="flow-history" aria-label="对话列表" hidden></section><div class="flow-history-feedback" role="status" hidden></div><div class="flow-conversation" role="log" aria-live="polite" aria-relevant="additions text" aria-label="与 Flow 的对话"></div><div class="flow-compose-area"><div class="flow-save-status" role="status"></div><div class="flow-compose-status" role="status"></div><div class="flow-attachment-preview" hidden></div><form id="flow-compose" class="flow-compose"><input type="file" id="flow-attachment-input" accept="${FLOW_ATTACHMENT_ACCEPT}" multiple hidden><div class="flow-draft-attachments" aria-label="待发送附件"></div><div class="flow-attachment-error" role="alert" hidden></div><label class="visually-hidden" for="flow-message">向 Flow 提问</label><textarea id="flow-message" name="message" rows="2" maxlength="4000" placeholder="问问 Flow…" enterkeyhint="send">${escape(current.draft)}</textarea><div class="flow-compose-bottom"><div class="flow-compose-tools"><button type="button" class="icon-button flow-attach-button" data-flow-action="attach" aria-label="上传附件" title="上传 PDF、表格或图片">${glyph('attach')}</button><span>可查询 · 确认后操作</span></div><button type="submit" class="flow-send" aria-label="发送消息">${glyph('send')}</button></div></form><div class="flow-composer-hint">回答基于当前数据，请核对重要结果</div></div></aside>`;
    renderAccess(); renderHistory(); renderMessages(); renderAttachments(); updateBusy(); renderSaveStatus();
  }
  function renderAttachments(){
    const area=root.querySelector('.flow-draft-attachments');if(!area)return;
    area.innerHTML=current.attachments.map(row=>`<div class="flow-attachment-chip"><button type="button" data-flow-action="view-attachment" data-flow-id="${escape(row.id)}">${glyph('attach')}<span>${escape(row.name)}</span><small>${row.pages} 页／表</small></button><button type="button" data-flow-action="remove-attachment" data-flow-id="${escape(row.id)}" aria-label="移除附件 ${escape(row.name)}">${glyph('close')}</button></div>`).join('')+pendingUploads.map(row=>`<div class="flow-attachment-chip ${row.status==='error'?'has-error':''}"><span>${glyph('attach')}${escape(row.file.name)}<small>${escape(row.error||row.progress||'正在读取…')}</small></span>${row.status==='error'?`<button type="button" data-flow-action="retry-attachment" data-flow-id="${row.id}">重试</button>`:''}<button type="button" data-flow-action="remove-attachment" data-flow-id="${row.id}" aria-label="移除附件 ${escape(row.file.name)}">${glyph('close')}</button></div>`).join('');
    const error=root.querySelector('.flow-attachment-error');error.textContent=attachmentError;error.hidden=!attachmentError;renderAttachmentPreview();
  }
  function renderAttachmentPreview(){
    const area=root.querySelector('.flow-attachment-preview');if(!area)return;area.hidden=!attachmentPreview;
    if(!attachmentPreview){area.innerHTML='';return;}
    area.innerHTML=`<header><strong>${escape(attachmentPreview.name||'附件内容')}</strong><button type="button" class="icon-button" data-flow-action="close-attachment" aria-label="关闭附件预览">${glyph('close')}</button></header><div class="flow-attachment-pages">${attachmentPreview.error?`<p role="alert">${escape(attachmentPreview.error)}</p>`:attachmentPreview.parts?attachmentPreview.parts.map(part=>`<section><h3>${escape(part.label)}</h3>${part.text?`<pre>${escape(part.text)}</pre>`:''}${/^\/api\/flow\/attachments\/[a-f0-9-]{36}\/parts\/\d+$/.test(part.imageUrl||'')?`<img src="${escape(part.imageUrl)}" alt="${escape(part.label)}">`:''}</section>`).join(''):'<p>正在读取…</p>'}</div>`;
  }
  async function showAttachment(id){
    if(!attachmentId(id))return;const preview={id};attachmentPreview=preview;renderAttachmentPreview();
    try{const result=await request('/attachments/'+id);if(attachmentPreview===preview){Object.assign(preview,{name:result.attachment.name,parts:result.parts});renderAttachmentPreview();}}
    catch(error){if(attachmentPreview===preview){preview.error=error.message;renderAttachmentPreview();}}
  }
  async function processAttachment(row,conversation){
    if(attachmentBusy()&&row.status==='error')return;row.status='reading';row.error='';row.controller=new AbortController();renderAttachments();updateBusy();
    try{
      if(!row.prepared){const prepare=prepareAttachment||(await import('./flow-attachment-reader.js')).prepareFlowAttachment;row.prepared=await prepare(row.file,{signal:row.controller.signal,onProgress:text=>{row.progress=text;if(current===conversation)renderAttachments();}});}
      row.controller.signal.throwIfAborted();row.status='uploading';row.progress='正在保存附件…';renderAttachments();
      const result=await request('/attachments',row.prepared);row.controller.signal.throwIfAborted();
      if(current!==conversation||!pendingUploads.includes(row)||destroyed)return;
      conversation.attachments.push(...cleanAttachmentRefs([result.attachment]));pendingUploads=pendingUploads.filter(item=>item!==row);touch(conversation);await saveConversation(conversation);
    }catch(error){if(pendingUploads.includes(row)){row.status='error';row.error=/[\u3400-\u9fff]/.test(error.message||'')?error.message:'附件读取失败，请检查文件是否损坏，或另存为 PDF／xlsx 后重试。';}}
    finally{if(!destroyed){renderAttachments();updateBusy();}}
  }
  async function selectAttachments(files){
    if(busy||transitioning||resolving||!connected()||attachmentBusy())return;
    const values=[...files];attachmentError='';if(values.length+current.attachments.length+pendingUploads.length>3){attachmentError='每条消息最多添加 3 个附件。';renderAttachments();return;}
    const conversation=current;selectionBusy=true;
    try{for(const file of values){if(destroyed||current!==conversation)break;const row={id:crypto.randomUUID(),file,status:'reading',progress:'正在读取…'};pendingUploads.push(row);await processAttachment(row,conversation);}}
    finally{selectionBusy=false;if(!destroyed){renderAttachments();updateBusy();}}
  }
  root.addEventListener('change',event=>{if(event.target.id==='flow-attachment-input'){const files=[...event.target.files];event.target.value='';selectAttachments(files);}},{signal:listeners.signal});
  root.addEventListener('dragover',event=>{if(event.dataTransfer?.types.includes('Files'))event.preventDefault();},{signal:listeners.signal});
  root.addEventListener('drop',event=>{if(event.dataTransfer?.files.length){event.preventDefault();selectAttachments(event.dataTransfer.files);}},{signal:listeners.signal});
  function renderAccess() {
    const marker=root.querySelector('.flow-status');
    if(marker){marker.classList.toggle('is-connected',connected());marker.querySelector('span').textContent=statusLabel();}
    const note=root.querySelector('.flow-access-note');if(!note)return;
    const message=statusError || (entitled()&&!connected()?(status?.message||'Flow 暂不可用，请联系平台管理员。'):'');
    note.hidden=!message;note.innerHTML=message?`<span>${escape(message)}</span><button type="button" class="text-button" data-flow-action="refresh-status">重试</button>`:'';
  }
  function renderProgress(message,index) {
    const steps=(message.steps||[]).filter(step=>step&&typeof step.label==='string'), tools=message.tools||[];
    const active=busy && index===current.messages.length-1 && !message.error && !message.stopped;
    const running=steps.findLast(step=>step.status==='running');
    const completed=steps.filter(step=>step.status==='done').length;
    const trace=steps.length?steps:tools.map((tool,i)=>({id:`legacy-${i}`,label:typeof tool==='string'?tool:tool.label||tool.name||'查询业务数据',status:'done'}));
    const stepIcon=step=>step.status==='done'?glyph('check'):step.status==='error'?glyph('close'):step.status==='stopped'?glyph('stop'):'<i></i>';
    return `${active?`<div class="flow-generation" role="status"><div class="flow-generation-caption"><span>${escape(running?.label || (message.text?'正在生成回复':'正在准备…'))}</span>${running?.detail?`<small>${escape(running.detail)}</small>`:''}</div><div class="flow-generation-track" aria-hidden="true"><span></span></div></div>`:''}${trace.length?`<details class="flow-tool-trace"><summary>${glyph(message.error?'close':message.stopped?'stop':'check')}<span>${active?'工作过程':message.stopped?'已停止':message.error?'处理未完成':'工作过程'} · 已完成 ${steps.length?completed:trace.length} 步</span>${glyph('chevron')}</summary><ol>${trace.map(step=>`<li class="is-${escape(['running','done','error','stopped'].includes(step.status)?step.status:'done')}"><span class="flow-step-symbol">${stepIcon(step)}</span><div><span>${escape(step.label)}</span>${step.detail?`<small>${escape(step.detail)}</small>`:''}</div></li>`).join('')}</ol></details>`:''}`;
  }
  function renderMessage(message,index) {
    if(message.role==='user')return `<article class="flow-message flow-message-user"><div class="flow-user-text">${escape(message.text)}</div>${(message.attachments||[]).map(row=>`<button type="button" class="flow-attachment-chip" data-flow-action="view-attachment" data-flow-id="${escape(row.id)}">${glyph('attach')}<span>${escape(row.name)}</span><small>${row.pages||1} 页／表</small></button>`).join('')}</article>`;
    const sources=message.sources||[], content=imagesFrom(message);
    return `<article class="flow-message flow-message-assistant" data-flow-message="${index}"><div class="flow-assistant-label">${FLOW_ICON}<strong>Flow</strong></div>${renderProgress(message,index)}<div class="flow-answer">${formatFlowText(content.text)}${content.images.map(renderImage).join('')}</div>${sources.length?`<div class="flow-sources" aria-label="数据来源">${sources.map(source=>{const href=safeFlowHref(source.href||source.url);return href?`<a href="${escape(href)}" class="flow-source-link">${escape(source.label||source.title||'查看记录')}${glyph('arrow')}</a>`:'';}).join('')}</div>`:''}${message.stopped?`<p class="flow-message-note">${message.mutations?.length?'已停止，已保存的操作仍然有效。':'已停止'}</p>`+ (index===current.messages.length-1?'<button type="button" class="text-button" data-flow-action="retry">继续核对</button>':''):''}${message.error?`<div class="flow-error" role="alert"><p>${escape(message.error)}</p>${index===current.messages.length-1?'<button type="button" class="text-button" data-flow-action="retry">重试</button>':''}</div>`:''}</article>`;
  }
  function renderMessages() {
    const log=root.querySelector('.flow-conversation'); if(!log)return;
    const old=log.scrollTop, bottom=log.scrollHeight-log.scrollTop-log.clientHeight<100;
    const openTraces=new Set([...log.querySelectorAll('.flow-tool-trace[open]')].map(node=>node.closest('[data-flow-message]').dataset.flowMessage));
    const focused=document.activeElement, focusedArticle=focused?.closest?.('[data-flow-message]'), focusIndex=focusedArticle?.dataset.flowMessage;
    const focusTarget=focused?.matches?.('.flow-tool-trace summary')?'summary':null;
    const focusHref=focused?.classList.contains('flow-source-link')?focused.getAttribute('href'):null;
    const focusProposal=focused?.closest?.('[data-flow-proposal]')?.dataset.flowProposal,focusAction=focused?.dataset?.flowAction;
    log.innerHTML=current.messages.length?current.messages.map(renderMessage).join(''):`<div class="flow-empty"><div class="flow-empty-mark">${FLOW_ICON}</div><h3>从这里开始</h3><div class="flow-suggestions">${promptChoices().map(text=>`<button type="button" data-flow-prompt="${escape(text)}"><span>${escape(text)}</span>${glyph('arrow')}</button>`).join('')}</div></div>`;
    current.messages.forEach((message,index)=>{
      const article=log.querySelector(`[data-flow-message="${index}"]`);
      if(article&&(message.proposals||[]).some(validProposal)) {
        const section=document.createElement('section');section.className='flow-proposals';section.setAttribute('aria-label','操作确认');
        section.innerHTML=(message.proposals||[]).filter(validProposal).map(row=>{
          const waiting=row.status==='pending',disabled=busy||transitioning||!!resolving||!entitled()||row.verifying;
          return `<div class="flow-proposal ${row.operation==='flow_import_attachment_rows'?'flow-import-proposal':''}" data-flow-proposal="${escape(row.id)}" tabindex="-1"><strong>${escape(row.label)} · ${escape(row.recordLabel)}</strong><dl>${(row.details||[]).map(field=>`<div><dt>${escape(field.label)}</dt><dd>${escape(field.value)}</dd></div>`).join('')}</dl><p>${escape(row.impact)}</p><small role="status">${({pending:row.verifying?'正在核对操作…':'尚未执行，请确认以上内容',saved:'已确认并保存',cancelled:'已取消，未执行',expired:'确认已过期，请重新发送请求'})[row.status]}</small>${waiting?`<div class="flow-proposal-actions"><button type="button" class="btn btn-primary" data-flow-action="confirm-operation" ${disabled?'disabled':''}>${resolving===row.id?'正在处理…':'确认'+(row.operation.includes('_delete_')?'删除':row.operation.includes('_create_')?'新增':row.operation.includes('_restore_')?'恢复':'修改')}</button><button type="button" class="btn btn-secondary" data-flow-action="cancel-operation" ${disabled?'disabled':''}>取消</button></div>`:''}${row.error?`<p class="flow-proposal-error" role="alert">${escape(row.error)}</p>`:''}</div>`;
        }).join('');article.append(section);
      }
      const rows=(message.mutations||[]).filter(row=>validMutation(row));
      if(!rows.length)return;
      const list=document.createElement('div');list.className='flow-mutations';list.setAttribute('aria-label','已保存的操作');
      list.innerHTML=rows.map(row=>`<a class="flow-mutation flow-source-link" href="${escape(safeFlowHref(row.href))}">${glyph('check')}<span><strong>${escape(row.label)} · ${escape(row.recordLabel)}</strong><small>${row.status==='pending_account'?'门店已保存，负责人登录待开通':'已保存'}${row.replayed?' · 已核对原操作':''}</small></span>${glyph('arrow')}</a>`).join('');
      log.querySelector(`[data-flow-message="${index}"] .flow-answer`)?.before(list);
    });
    for(const id of openTraces)log.querySelector(`[data-flow-message="${id}"] .flow-tool-trace`)?.setAttribute('open','');
    if(focusIndex&&focusTarget)log.querySelector(`[data-flow-message="${focusIndex}"] ${focusTarget}`)?.focus({preventScroll:true});
    if(focusIndex&&focusHref)[...log.querySelectorAll(`[data-flow-message="${focusIndex}"] .flow-source-link`)].find(node=>node.getAttribute('href')===focusHref)?.focus({preventScroll:true});
    if(focusProposal){const card=[...log.querySelectorAll('[data-flow-proposal]')].find(node=>node.dataset.flowProposal===focusProposal);(card?.querySelector(`[data-flow-action="${focusAction}"]:not(:disabled)`)||card)?.focus({preventScroll:true});}
    log.scrollTop=bottom?log.scrollHeight:old;
    root.querySelector('.flow-thread-title').textContent=title(current);
  }
  function renderHistory() {
    const panel=root.querySelector('.flow-history'); if(!panel)return;
    panel.hidden=!historyOpen; root.querySelector('.flow-conversation').hidden=historyOpen; root.querySelector('.flow-compose-area').hidden=historyOpen;
    root.querySelector('[data-flow-action="history"]').setAttribute('aria-expanded',String(historyOpen));
    const date=value=>{const d=new Date(value);return Number.isNaN(d.valueOf())?'':new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(d);};
    panel.innerHTML=`<div class="flow-history-heading"><strong>对话记录 <span>${conversations.length}</span></strong><button type="button" class="icon-button" data-flow-action="refresh-history" aria-label="刷新对话列表" ${historyLoading?'disabled':''}>${glyph('refresh')}</button></div>${historyError?`<p class="flow-history-error" role="alert">${escape(historyError)}</p>`:''}${historyLoading&&!conversations.length?'<p class="flow-history-empty">正在加载…</p>':conversations.length?`<ul class="flow-history-list">${conversations.map(item=>`<li class="${item.id===current.id?'is-current':''}"><button type="button" class="flow-history-select" data-flow-action="select-conversation" data-flow-id="${escape(item.id)}" ${transitioning?'disabled':''} ${item.id===current.id?'aria-current="true"':''}><span>${escape(item.title||'新对话')}</span><small>${escape(date(item.updatedAt))} · ${Number(item.messageCount)||0} 条消息</small></button><button type="button" class="icon-button flow-delete-conversation" data-flow-action="delete-conversation" data-flow-id="${escape(item.id)}" aria-label="删除对话：${escape(item.title||'新对话')}" title="删除对话" ${transitioning?'disabled':''}>${glyph('trash')}</button></li>`).join('')}</ul>`:'<div class="flow-history-empty"><p>还没有保存的对话</p><button type="button" class="text-button" data-flow-action="new">开始新对话</button></div>'}`;
    renderFeedback();
  }
  function renderFeedback() {
    const feedback=root.querySelector('.flow-history-feedback'); if(!feedback)return;
    feedback.hidden=!deleted;
    feedback.innerHTML=deleted?`<span>对话已删除</span><button type="button" data-flow-action="undo-delete">撤销</button><button type="button" class="icon-button" data-flow-action="dismiss-delete" aria-label="关闭提示">${glyph('close')}</button>`:'';
  }
  function renderSaveStatus() {
    const node=root.querySelector('.flow-save-status'); if(!node)return;
    node.innerHTML=current.error?`<span>${escape(current.error)}</span><button type="button" data-flow-action="save-again">重新保存</button>`:'';
    node.classList.toggle('has-error',Boolean(current.error));
    if(current.error&&historyOpen){historyError=current.error;renderHistory();}
  }
  function updateBusy(label='') {
    const button=root.querySelector('.flow-send'); if(!button)return;
    button.innerHTML=glyph(busy?'stop':'send'); button.setAttribute('aria-label',busy?'停止生成':'发送消息'); button.classList.toggle('is-stopping',busy); button.disabled=!!resolving||transitioning||attachmentBusy()||pendingUploads.length>0||(!busy&&(!(current.draft.trim()||current.attachments.length)||!connected()));
    root.querySelector('.flow-compose-status').textContent=busy?label||'Flow 正在处理…':'';
    const attach=root.querySelector('[data-flow-action="attach"]');if(attach)attach.disabled=busy||transitioning||!!resolving||attachmentBusy()||!connected()||current.attachments.length+pendingUploads.length>=3;
    root.querySelector('.flow-conversation').setAttribute('aria-busy',String(busy));
    root.querySelectorAll('[data-flow-action="new"],[data-flow-action="history"]').forEach(node=>{node.disabled=transitioning||!!resolving||attachmentBusy()||pendingUploads.length>0;});
  }
  async function refreshHistory() {
    const requestId=++historyRequest, startedAt=historyMutation; historyLoading=true; renderHistory();
    try {
      const result=await request('/conversations');if(requestId!==historyRequest||destroyed)return;
      const rows=new Map((Array.isArray(result.conversations)?result.conversations:[]).map(row=>[row.id,row]));
      for(const [id,change] of historyChanges)if(change.revision>startedAt){if(change.item)rows.set(id,change.item);else rows.delete(id);}
      conversations=[...rows.values()].sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0,100);historyError='';
    }
    catch(error){if(requestId===historyRequest)historyError=error.message;}
    finally{if(requestId===historyRequest){historyLoading=false;if(!destroyed)renderHistory();}}
  }
  function saveConversation(conversation=current) {
    clearTimeout(draftTimer); draftTimer=null;
    const save=async()=>{
      if(destroyed||!entitled())return false;
      if(!conversation.messages.length&&!conversation.draft.trim()&&!conversation.attachments.length&&!conversation.id)return true;
      if(conversation.revision===conversation.savedRevision && conversation.id && !conversation.error)return true;
      conversation.saving=true;
      const revision=conversation.revision;
      const body={messages:JSON.parse(JSON.stringify(conversation.messages)),draft:conversation.draft,attachments:conversation.attachments,...(conversation.id?{id:conversation.id,version:conversation.version}:{})};
      try {
        const result=await request('/conversations',body);
        if(!result.conversation?.id)throw new Error('对话尚未保存，请重试。');
        Object.assign(conversation,{id:result.conversation.id,version:result.conversation.version,savedRevision:revision,error:''});
        const item={id:conversation.id,title:result.conversation.title||title(conversation),updatedAt:result.conversation.updatedAt||new Date().toISOString(),messageCount:body.messages.length};
        conversations=[item,...conversations.filter(row=>row.id!==item.id)].slice(0,100);
        historyChanges.set(item.id,{revision:++historyMutation,item});
        return true;
      } catch(error){conversation.error=error.status===409?'对话在另一窗口有更新。本页内容已保留，请勿刷新。':error.status===410?'这条对话已被删除。本页内容已保留。':`未能保存对话：${error.message}`;return false;}
      finally{conversation.saving=false;if(!destroyed){if(current===conversation)renderSaveStatus();if(historyOpen)renderHistory();}}
    };
    conversation.queue=conversation.queue.then(save,save); return conversation.queue;
  }
  function stopCurrent() {
    if(!busy)return;
    generation++;controller?.abort();controller=null;busy=false;
    const last=current.messages.at(-1);if(last?.role==='assistant'){delete last.pending;last.stopped=true;finishProgress(last,'stopped');touch();}
    updateBusy();renderMessages();
  }
  async function changeConversation(id=null) {
    if(transitioning||resolving||attachmentBusy()||pendingUploads.length)return; transitioning=true; stopCurrent();updateBusy();
    if(!await saveConversation()){transitioning=false;updateBusy();return;}
    try {
      const next=id?newConversation((await request(`/conversations/${id}`)).conversation):newConversation();
      current=next;pendingUploads=[];attachmentError='';attachmentPreview=null;renderAttachments();historyOpen=false;historyError='';
      for(const message of current.messages)for(const row of message.proposals||[])row.verifying=true;
      renderShell();await recoverProposals(current);root.querySelector('textarea')?.focus({preventScroll:true});
    } catch(error){historyError=error.message;renderHistory();}
    finally{transitioning=false;updateBusy();renderHistory();renderMessages();}
  }
  async function deleteConversation(id) {
    if(transitioning||resolving)return;transitioning=true;historyError='';
    if(current.id===id)stopCurrent();updateBusy();renderHistory();
    try {
      if(current.id===id)await current.queue;
      await request(`/conversations/${id}/delete`,{});
      deleted={id,title:conversations.find(row=>row.id===id)?.title||'对话'};
      conversations=conversations.filter(row=>row.id!==id);
      historyChanges.set(id,{revision:++historyMutation,item:null});
      if(current.id===id){current=newConversation();renderMessages();root.querySelector('textarea').value='';}
    }catch(error){historyError=error.message;}
    finally{transitioning=false;updateBusy();renderHistory();renderSaveStatus();}
  }
  async function restoreConversation() {
    if(!deleted||transitioning)return;transitioning=true;const restoring=deleted;
    try {
      const {conversation}=await request(`/conversations/${restoring.id}/restore`,{});
      const item={id:conversation.id,title:conversation.title||title(conversation),updatedAt:conversation.updatedAt,messageCount:conversation.messages.length};
      historyChanges.set(item.id,{revision:++historyMutation,item});
      if(deleted===restoring)deleted=null;await refreshHistory();
    }
    catch(error){historyError=error.message;historyOpen=true;}
    finally{transitioning=false;renderHistory();updateBusy();}
  }
  function refreshStatus() {
    if(statusFlight)return statusFlight;
    statusFlight=(async()=>{
      try {
        const next=await request('/status');if(destroyed)return;
        status=next;statusError='';
        if(!entitled()){pendingOpen=false;clearTimeout(draftTimer);draftTimer=null;if(busy)stopCurrent();if(opened)close({persist:false});}
        sync();renderAccess();updateBusy();
        if(pendingOpen&&entitled()){pendingOpen=false;open();}
      }catch(error){if(!destroyed){statusError='Flow 状态暂时无法更新，请稍后重试。';renderAccess();sync();}}
    })().finally(()=>{statusFlight=null;});
    return statusFlight;
  }
  function open() {
    if(!status){pendingOpen=true;refreshStatus();return;}
    if(!entitled())return;
    if(opened){root.querySelector('textarea')?.focus();return;}
    opened=true;returnFocus=document.activeElement;onOpen();document.body.classList.add('flow-is-open');renderShell();sync();
    root.querySelector('textarea')?.focus({preventScroll:true});refreshStatus();refreshHistory();
  }
  function close({persist=true}={}) {
    if(persist&&entitled())saveConversation();pendingOpen=false;opened=false;document.body.classList.remove('flow-is-open');root.querySelector('.flow-panel')?.setAttribute('hidden','');sync();
    if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});else document.querySelector('[data-flow-action="open"]:not(:disabled)')?.focus({preventScroll:true});
  }
  function finishProgress(answer,state) {
    for(const step of answer.steps||[])if(step.status==='running')step.status=state;
  }
  function recordProgress(answer,event) {
    if(!/^(prepare|model|answer|tool-\d+)$/.test(event.id||'') || !['running','done','error'].includes(event.status) || typeof event.label!=='string')return;
    answer.steps||=[];
    const next={id:event.id,label:event.label.slice(0,100),status:event.status,...(typeof event.detail==='string'?{detail:event.detail.slice(0,200)}:{})};
    const existing=answer.steps.find(step=>step.id===next.id);
    if(existing)Object.assign(existing,next);else if(answer.steps.length<40)answer.steps.push(next);else return false;
    return true;
  }
  function onEvent(event,answer,conversation) {
    const kind=event.type||event.event;
    // Only final text and the server's public workflow events are visible. Model
    // reasoning channels never enter the transcript, DOM or saved conversation.
    if(/reasoning|analysis|thinking/i.test(kind) || /reasoning|analysis|thinking/i.test(event.phase||''))return;
    if(kind==='delta'||kind==='text')answer.text+=event.text??event.delta??event.content??'';
    if(kind==='message'||kind==='answer'||kind==='done'){
      if(event.text||event.answer)answer.text=event.text||event.answer;
      if(event.sources||event.citations)answer.sources=event.sources||event.citations;
      if(event.tools)answer.tools=event.tools;
      if(Array.isArray(event.steps))for(const step of event.steps)recordProgress(answer,step);
      if(Array.isArray(event.images)){answer.images||=[];for(const image of event.images)if(safeFlowImageHref(image?.url)&&!answer.images.some(row=>row.url===image.url))answer.images.push(image);}
      if(Array.isArray(event.mutations))for(const mutation of event.mutations)recordMutation(answer,mutation);
      if(Array.isArray(event.proposals))for(const proposal of event.proposals)recordProposal(answer,proposal);
    }
    if(kind==='progress'){
      if(recordProgress(answer,event))updateBusy(event.status==='running'?event.label.slice(0,100):'正在整理回答…');
    }
    if(kind==='image'&&event.image){answer.images||=[];if(safeFlowImageHref(event.image.url)&&!answer.images.some(image=>image.url===event.image.url))answer.images.push(event.image);}
    if(kind==='tool'||kind==='tool_start'||kind==='tool_result'){
      const label=String(event.label||event.name||'查询业务数据').slice(0,100);
      if(kind!=='tool_start'&&event.status!=='running'&&!answer.tools.some(tool=>(tool.label||tool)===label))answer.tools.push({label});
      updateBusy(kind==='tool_result'?'正在整理回答…':label);
    }
    if(kind==='sources'||kind==='citations')answer.sources=event.sources||event.citations||[];
    if(kind==='mutation')recordMutation(answer,event.mutation);
    if(kind==='proposal')recordProposal(answer,event.proposal);
    if(kind==='status')updateBusy('正在处理…');
    if(kind==='error')throw new Error(event.message||event.error||'回答中断，请重试。');
    touch(conversation);renderMessages();
  }
  async function sendStream(payload,signal,handleEvent) {
    if(sendOverride)return sendOverride(payload,{signal,onEvent:handleEvent});
    const response=await fetch(endpoint+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(payload),signal});
    if(!response.ok){let error;try{error=await response.json();}catch{}throw new Error(error?.error||'暂时无法生成回答，请重试。');}
    if(response.headers.get('content-type')?.includes('application/json')){handleEvent({type:'done',...await response.json()});return;}
    const reader=response.body.getReader(), decoder=new TextDecoder();let pending='',finished=false;
    const consume=line=>{const text=line.startsWith('data:')?line.slice(5).trim():line.trim();if(!text||text==='[DONE]'||!text.startsWith('{'))return;let data;try{data=JSON.parse(text);}catch{throw new Error('回答数据未完整接收，请重试。');}if(data.type==='done')finished=true;handleEvent(data);};
    try {while(true){const {value,done}=await reader.read();pending+=decoder.decode(value,{stream:!done});if(pending.length>1000000)throw new Error('回答数据过长，请缩小问题范围。');const lines=pending.split('\n');pending=lines.pop();for(const line of lines)consume(line);if(done){if(pending.trim())consume(pending);if(!finished)throw new Error('回答连接中断，请重试。');break;}}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
  }
  function validMutation(row) {
    return row&&typeof row.id==='string'&&/^flow:[a-f0-9-]{36}:flow_[a-z_]+:[a-f0-9]{64}$/.test(row.id)&&safeFlowHref(row.href)&&['saved','pending_account'].includes(row.status)&&Number.isSafeInteger(row.revision)&&row.revision>=0;
  }
  function validProposal(row) {
    const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    return row&&uuid.test(row.id||'')&&uuid.test(row.requestId||'')&&['pending','saved','cancelled','expired'].includes(row.status);
  }
  function recordProposal(answer,row) {
    if(!validProposal(row))return;
    const clip=(value,max)=>String(value||'').slice(0,max);
    const proposal={id:row.id,requestId:row.requestId,operation:clip(row.operation,64),label:clip(row.label,80),recordLabel:clip(row.recordLabel,160),impact:clip(row.impact,500),status:row.status,details:(Array.isArray(row.details)?row.details:[]).slice(0,24).map(field=>({label:clip(field?.label,80),value:clip(field?.value,4000)}))};
    answer.proposals||=[];const existing=answer.proposals.find(item=>item.id===proposal.id);
    if(existing){Object.assign(existing,proposal);delete existing.verifying;delete existing.error;}
    else if(answer.proposals.length<6)answer.proposals.push(proposal);
  }
  async function recoverProposals(conversation) {
    for(let i=1;i<conversation.messages.length;i++){
      const answer=conversation.messages[i],user=conversation.messages[i-1];
      if(answer.role!=='assistant'||!user.requestId||!(answer.proposals?.length||answer.error||answer.stopped))continue;
      try {
        const result=await request('/actions/'+user.requestId);
        answer.proposals=[];for(const row of result.proposals||[])recordProposal(answer,row);
        for(const row of result.mutations||[])recordMutation(answer,row);
      }catch(error){for(const row of answer.proposals||[]){row.verifying=true;row.error='操作状态暂时无法核对，请重新打开对话。';}}
    }
    touch(conversation);if(current===conversation)renderMessages();
  }
  async function resolveProposal(button,decision) {
    if(busy||transitioning||resolving||!entitled())return;
    const id=button.closest('[data-flow-proposal]')?.dataset.flowProposal,conversation=current;
    const answer=conversation.messages.find(message=>message.proposals?.some(row=>row.id===id)),proposal=answer?.proposals.find(row=>row.id===id);
    if(!proposal||proposal.status!=='pending'||proposal.verifying)return;
    resolving=id;delete proposal.error;updateBusy();renderMessages();
    try {
      const result=await request('/actions/'+id+'/'+decision,{});
      recordProposal(answer,result.proposal);for(const row of result.mutations||[])recordMutation(answer,row);
    }catch(error){
      proposal.error=error.message||'处理结果暂未确认，请重试核对。';
      // A lost response may follow a successful commit. Recover the durable
      // receipt before offering another confirmation of the same operation.
      try {const result=await request('/actions/'+proposal.requestId);for(const row of result.proposals||[])recordProposal(answer,row);for(const row of result.mutations||[])recordMutation(answer,row);if(proposal.status==='pending')proposal.error=error.message;}catch{}
    }finally{resolving=null;touch(conversation);if(!destroyed){updateBusy();renderMessages();}await saveConversation(conversation);}
  }
  function recordMutation(answer,row) {
    if(!validMutation(row))return;
    answer.mutations||=[];
    const mutation={id:row.id,operation:String(row.operation||'').slice(0,64),label:String(row.label||'业务操作').slice(0,80),recordId:String(row.recordId||'').slice(0,160),recordLabel:String(row.recordLabel||'').slice(0,160),href:safeFlowHref(row.href),revision:row.revision,status:row.status,replayed:row.replayed===true};
    const existing=answer.mutations.find(item=>item.id===mutation.id);
    if(existing)Object.assign(existing,mutation);else if(answer.mutations.length<6)answer.mutations.push(mutation);else return;
    if(!notifiedMutations.has(mutation.id)){
      notifiedMutations.add(mutation.id);
      Promise.resolve().then(()=>onBusinessChange(mutation)).catch(()=>{});
    }
  }
  async function send(text,retryId,priorMutations=[],retryAttachments) {
    const attached=cleanAttachmentRefs(retryAttachments||current.attachments);const prompt=String(text||'').trim()||(attached.length?'请识别附件，列出内容和需要核对的信息。':'' );if(!prompt||busy||transitioning||resolving||attachmentBusy()||pendingUploads.length)return;
    if(!connected()){renderAccess();return;}
    historyOpen=false;renderHistory();
    const conversation=current, requestGeneration=++generation;busy=true;controller=new AbortController();const signal=controller.signal;
    let chars=0;
    const history=conversation.messages.filter(message=>!message.error&&message.text).slice(-12).reverse().filter(message=>{chars+=message.text.length;return chars<=24000;}).reverse().map(({role,text,attachments})=>({role,content:text,...(attachments?.length?{attachments}:{})}));
    const requestId=retryId||crypto.randomUUID();
    conversation.draft='';conversation.attachments=[];renderAttachments();conversation.messages.push({role:'user',text:prompt,requestId,...(attached.length?{attachments:attached}:{})});
    const answer={role:'assistant',text:'',tools:[],sources:[],images:[],steps:[],mutations:priorMutations.filter(validMutation),pending:true};conversation.messages.push(answer);touch(conversation);
    const textarea=root.querySelector('textarea');if(textarea){textarea.value='';textarea.style.height='';}
    updateBusy();renderMessages();
    try {
      if(!await saveConversation(conversation)){answer.error='对话尚未保存，操作尚未执行。请重试。';return;}
      if(generation!==requestGeneration)return;
      if(signal.aborted){answer.stopped=true;return;}
      const result=await sendStream({message:prompt,requestId,history,...(attached.length?{attachments:attached}:{}),context:getContext(),...(conversation.id?{conversationId:conversation.id}:{})},signal,event=>{if(generation===requestGeneration&&current===conversation)onEvent(event,answer,conversation);});
      if(generation!==requestGeneration)return;
      if(result)onEvent({type:'done',...result},answer,conversation);
      if(!answer.text&&!answer.images.length&&!answer.mutations.length&&!answer.proposals?.length)answer.error='没有收到回答，请重试。';
    }catch(error){if(generation!==requestGeneration)return;if(error.name==='AbortError')answer.stopped=true;else answer.error=error.message||'连接中断，请重试。';}
    finally{if(generation===requestGeneration){delete answer.pending;finishProgress(answer,answer.stopped?'stopped':answer.error?'error':'done');busy=false;controller=null;touch(conversation);updateBusy();renderMessages();await saveConversation(conversation);}}
  }
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-flow-action],[data-flow-prompt]');if(!button||button.disabled)return;event.preventDefault();
    if(button.dataset.flowPrompt){await send(button.dataset.flowPrompt);return;}
    const action=button.dataset.flowAction;
    if(action==='confirm-operation'||action==='cancel-operation'){await resolveProposal(button,action==='confirm-operation'?'confirm':'cancel');return;}
    if(action==='attach'){root.querySelector('#flow-attachment-input').click();return;}
    if(action==='remove-attachment'){const id=button.dataset.flowId;const pending=pendingUploads.find(row=>row.id===id);pending?.controller?.abort();pendingUploads=pendingUploads.filter(row=>row.id!==id);current.attachments=current.attachments.filter(row=>row.id!==id);touch();renderAttachments();updateBusy();await saveConversation();return;}
    if(action==='retry-attachment'){const row=pendingUploads.find(row=>row.id===button.dataset.flowId);if(row)await processAttachment(row,current);return;}
    if(action==='view-attachment'){await showAttachment(button.dataset.flowId);return;}
    if(action==='close-attachment'){attachmentPreview=null;renderAttachmentPreview();return;}
    if(action==='open')open(); if(action==='close')close();
    if(action==='history'){historyOpen=!historyOpen;if(historyOpen){if(!await saveConversation()){historyError=current.error;renderHistory();return;}await refreshHistory();}renderHistory();}
    if(action==='new')await changeConversation();
    if(action==='select-conversation')await changeConversation(button.dataset.flowId);
    if(action==='delete-conversation')await deleteConversation(button.dataset.flowId);
    if(action==='undo-delete')await restoreConversation();
    if(action==='dismiss-delete'){deleted=null;renderFeedback();}
    if(action==='refresh-history')await refreshHistory();
    if(action==='save-again')await saveConversation();
    if(action==='retry'){
      if(busy||transitioning)return;
      if(!connected()){renderAccess();return;}
      const lastUser=current.messages.findLast(message=>message.role==='user');if(!lastUser)return;
      const priorMutations=current.messages.at(-1)?.mutations||[];
      current.messages=current.messages.slice(0,-2);touch();await send(lastUser.text,lastUser.requestId,priorMutations,lastUser.attachments||[]);
    }
    if(action==='refresh-status')await refreshStatus();
  },{signal:listeners.signal});
  root.addEventListener('input',event=>{
    if(event.target.id!=='flow-message')return;
    current.draft=event.target.value;touch();event.target.style.height='auto';event.target.style.height=Math.min(event.target.scrollHeight,150)+'px';updateBusy();
    clearTimeout(draftTimer);if(!busy)draftTimer=setTimeout(()=>saveConversation(),900);
  },{signal:listeners.signal});
  root.addEventListener('click',event=>{const link=event.target.closest('.flow-source-link,.flow-answer-link');if(link&&onNavigate){const href=safeFlowHref(link.getAttribute('href'));if(href){event.preventDefault();onNavigate(href);}}},{signal:listeners.signal});
  for(const eventName of ['load','error'])root.addEventListener(eventName,event=>{if(!event.target.matches?.('[data-flow-image]'))return;const figure=event.target.closest('.flow-image');figure?.classList.add(eventName==='load'?'is-loaded':'has-error');if(eventName==='error')figure.querySelector('.flow-image-state').textContent='图片暂时无法加载，请稍后再试。';},{capture:true,signal:listeners.signal});
  root.addEventListener('submit',async event=>{
    event.preventDefault();event.stopPropagation();
    if(event.target.id!=='flow-compose')return;
    if(busy){stopCurrent();await saveConversation();}else send(current.draft);
  },{signal:listeners.signal});
  document.addEventListener('keydown',event=>{
    if(!opened)return;
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(historyOpen){historyOpen=false;renderHistory();}else close();}
    if(event.target.id==='flow-message'&&event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();if(!busy)send(current.draft);}
    if(event.key==='Tab'&&window.matchMedia?.('(max-width: 720px)').matches){const nodes=[...root.querySelectorAll('button:not(:disabled),a[href],textarea,input:not([type=hidden]),select,summary,[tabindex="0"]')].filter(el=>!el.closest('[hidden]')&&el.getClientRects().length),first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
  },{capture:true,signal:listeners.signal});
  renderShell();
  refreshStatus();
  policyTimer=setInterval(()=>{if(!document.hidden)refreshStatus();},15000);
  window.addEventListener('focus',()=>refreshStatus(),{signal:listeners.signal});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshStatus();},{signal:listeners.signal});
  return {launcher,sync,open,close,refreshStatus,destroy(){destroyed=true;generation++;controller?.abort();listeners.abort();for(const row of pendingUploads)row.controller?.abort();clearInterval(policyTimer);clearTimeout(draftTimer);root.remove();document.body.classList.remove('flow-is-open');}};
}
