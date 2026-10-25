import {t, tx, ta, setI18nText} from "../i18n/index.js";
const MAX_BYTES=200*1024;
const MIME_TYPES=new Set(['image/png','image/jpeg','image/webp']);

export function safeAvatarUrl(value) {
  if(typeof value!=='string'||!value.startsWith('/api/')||value.length>700)return '';
  try {
    const url=new URL(value,'https://avatar.invalid');
    const key=url.pathname==='/api/account-avatar'?'account':url.pathname==='/api/organization-avatar'?'tenant':null;
    if(!key||url.hash||![...url.searchParams.keys()].every(name=>name===key||name==='v')||url.searchParams.getAll(key).length!==1||!url.searchParams.get(key)||url.searchParams.get(key).length>160)return '';
    if(url.searchParams.has('v')&&!/^\d+$/.test(url.searchParams.get('v')))return '';
    return value;
  } catch {return '';}
}

export function createAvatarEditor(ctx) {
  const {request,modal,button,icon,escape:esc,closeOverlay,toast=()=>{},onSaved=()=>{}}=ctx;
  let state=null;
  const active=current=>!!current&&state===current&&current.form?.isConnected;
  const imageMarkup=(image,name)=>image?`<img src="${esc(image)}" ${ta("alt", "{0}头像预览", [esc(name)])}>`:`<span>${esc(String(name||'头像').slice(0,1))}</span>`;
  function dispose(){if(state){state.image=null;state.source=null;state.crop=null;}state=null;}
  function open(options) {
    const next={kind:options.kind==='organization'?'organization':'account',id:options.id,name:options.name||'头像',version:Number.isSafeInteger(options.avatarVersion)?options.avatarVersion:0,image:safeAvatarUrl(options.avatarUrl)||null,source:null,crop:null,busy:false,changed:false};
    if(!next.id)throw new Error('缺少头像所属账号，请刷新后重试。');
    const title=next.kind==='organization'?'厨房头像':'个人头像';
    modal(title,`<div class="avatar-editor"><div class="avatar-editor-identity"><div class="avatar-editor-preview ${next.kind==='organization'?'is-organization':''}" id="avatar-preview">${imageMarkup(next.image,next.name)}</div><div><strong>${esc(next.name)}</strong><div class="avatar-editor-actions">${button((next.image ? tx("更换图片") : tx("上传图片")),'accounts-avatar-choose','secondary','type="button"')}${button(tx("裁剪"),'accounts-avatar-recrop','ghost',`type="button" ${next.image?'':'hidden'}`)}${button(tx("移除"),'accounts-avatar-remove','ghost',`type="button" ${next.image?'':'hidden'}`)}</div></div></div><input id="account-avatar-file" type="file" accept="image/png,image/jpeg,image/webp" hidden><div class="avatar-crop" id="avatar-crop" hidden><canvas id="avatar-crop-canvas" width="320" height="320" tabindex="0" role="img" ${ta("aria-label", "正方形头像裁剪，可拖动或使用方向键调整")}></canvas><div class="avatar-crop-controls"><label for="avatar-crop-zoom">${tx("缩放")}</label><input type="range" id="avatar-crop-zoom" min="1" max="3" step="0.01" value="1"><output id="avatar-crop-scale" for="avatar-crop-zoom">100%</output></div><div class="avatar-crop-actions">${button(tx("取消裁剪"),'accounts-avatar-cancel-crop','secondary','type="button"')}${button(tx("使用此裁剪"),'accounts-avatar-apply-crop','primary','type="button"')}</div></div><p class="form-hint">${tx("JPG、PNG 或 WebP，最大 5 MB。上传后裁剪为正方形。")}</p><p id="avatar-editor-error" class="accounts-form-error" role="alert"></p></div>`,button(tx("取消"),'close','secondary','type="button"')+`<button type="submit" class="btn btn-primary" disabled>${tx("保存头像")}</button>`,'accounts-avatar-form');
    state=next;next.form=document.getElementById('accounts-avatar-form');
    if(!next.form)return;
    next.form.closest('.modal')?.classList.add('accounts-avatar-modal');
    next.form.querySelector('#account-avatar-file').addEventListener('change',event=>selectFile(next,event.target));
    next.form.querySelector('#avatar-crop-zoom').addEventListener('input',event=>{if(!active(next)||!next.crop)return;next.crop.zoom=Number(event.target.value);draw(next);});
    bindCanvas(next);sync(next);
  }
  function error(current,message){if(active(current))current.form.querySelector('#avatar-editor-error').textContent=message||'';}
  function sync(current) {
    if(!active(current))return;
    const form=current.form,cropping=!!current.crop;
    form.querySelector('#avatar-preview').innerHTML=imageMarkup(current.image,current.name);
    form.querySelector('#avatar-crop').hidden=!cropping;
    for(const action of ['choose','recrop','remove']){
      const node=form.querySelector(`[data-action="accounts-avatar-${action}"]`);node.disabled=current.busy||cropping;
      if(action!=='choose')node.hidden=!current.image;
    }
    setI18nText(form.querySelector('[data-action="accounts-avatar-choose"]'), () => (current.image ? t("更换图片") : t("上传图片")), "textContent");
    const submit=form.querySelector('[type="submit"]');submit.disabled=current.busy||cropping||!current.changed;setI18nText(submit, () => (current.busy ? t("保存中…") : t("保存头像")), "textContent");
    form.setAttribute('aria-busy',String(current.busy));
  }
  async function selectFile(current,input) {
    const file=input.files?.[0];input.value='';if(!file||!active(current)||current.busy)return;
    error(current,'');current.busy=true;sync(current);
    try {
      if(!MIME_TYPES.has(file.type))throw new Error('请选择 JPG、PNG 或 WebP 图片。');
      if(file.size>5*1024*1024)throw new Error('图片不能超过 5 MB。');
      const url=URL.createObjectURL(file),image=new Image();
      try{image.src=url;await image.decode();}finally{URL.revokeObjectURL(url);}
      if(!active(current))return;
      if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth*image.naturalHeight>40000000)throw new Error('请使用 4000 万像素以内的图片。');
      beginCrop(current,image);
    }catch(failure){error(current,failure.message||'图片读取失败，请重试。');}
    finally{current.busy=false;sync(current);}
  }
  async function recrop(current) {
    if(!active(current)||!current.image||current.busy)return;
    if(current.source){beginCrop(current,current.source);return;}
    current.busy=true;error(current,'');sync(current);
    try{const image=new Image();image.src=current.image;await image.decode();if(active(current))beginCrop(current,image);}
    catch{error(current,'无法读取头像，请重新上传。');}
    finally{current.busy=false;sync(current);}
  }
  function beginCrop(current,image){
    current.crop={image,zoom:1,x:.5,y:.5};current.form.querySelector('#avatar-crop-zoom').value='1';sync(current);draw(current);
    current.form.querySelector('#avatar-crop-canvas').focus({preventScroll:true});
  }
  function bounds(crop){const side=Math.min(crop.image.naturalWidth,crop.image.naturalHeight)/crop.zoom;return {side,x:(crop.image.naturalWidth-side)*crop.x,y:(crop.image.naturalHeight-side)*crop.y};}
  function draw(current){
    if(!active(current)||!current.crop)return;
    const canvas=current.form.querySelector('#avatar-crop-canvas'),context=canvas.getContext('2d'),{side,x,y}=bounds(current.crop);
    context.clearRect(0,0,canvas.width,canvas.height);context.drawImage(current.crop.image,x,y,side,side,0,0,canvas.width,canvas.height);
    current.form.querySelector('#avatar-crop-scale').textContent=Math.round(current.crop.zoom*100)+'%';
  }
  function bindCanvas(current){
    const canvas=current.form.querySelector('#avatar-crop-canvas'),clamp=value=>Math.max(0,Math.min(1,value));let pointer=null;
    canvas.addEventListener('pointerdown',event=>{if(!current.crop)return;pointer={x:event.clientX,y:event.clientY};canvas.setPointerCapture?.(event.pointerId);event.preventDefault();});
    canvas.addEventListener('pointermove',event=>{if(!pointer||!current.crop)return;const crop=current.crop,{side}=bounds(crop),size=canvas.getBoundingClientRect().width;
      const width=crop.image.naturalWidth-side,height=crop.image.naturalHeight-side;
      if(width)crop.x=clamp(crop.x-(event.clientX-pointer.x)*side/size/width);if(height)crop.y=clamp(crop.y-(event.clientY-pointer.y)*side/size/height);pointer={x:event.clientX,y:event.clientY};draw(current);
    });
    for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,()=>{pointer=null;});
    canvas.addEventListener('keydown',event=>{if(!current.crop||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();const axis=['ArrowLeft','ArrowRight'].includes(event.key)?'x':'y';current.crop[axis]=clamp(current.crop[axis]+(['ArrowRight','ArrowDown'].includes(event.key)?.025:-.025));draw(current);});
  }
  function applyCrop(current){
    const canvas=current.form.querySelector('#avatar-crop-canvas');let quality=.9,image=canvas.toDataURL('image/webp',quality);
    while(atob(image.split(',')[1]).length>MAX_BYTES&&quality>.35){quality-=.1;image=canvas.toDataURL('image/webp',quality);}
    if(atob(image.split(',')[1]).length>MAX_BYTES)throw new Error('头像内容过于复杂，请选择其他图片。');
    current.image=image;current.source=current.crop.image;current.crop=null;current.changed=true;error(current,'');sync(current);
  }
  async function handleAction(action){
    if(!action.startsWith('accounts-avatar-'))return false;
    const current=state;if(!active(current)||current.busy)return true;
    if(action==='accounts-avatar-choose')current.form.querySelector('#account-avatar-file').click();
    if(action==='accounts-avatar-recrop')await recrop(current);
    if(action==='accounts-avatar-remove'){current.image=null;current.source=null;current.crop=null;current.changed=true;error(current,'');sync(current);}
    if(action==='accounts-avatar-cancel-crop'){current.crop=null;sync(current);}
    if(action==='accounts-avatar-apply-crop'&&current.crop){try{applyCrop(current);}catch(failure){error(current,failure.message);}}
    return true;
  }
  async function handleSubmit(form){
    if(form.id!=='accounts-avatar-form')return false;
    const current=state;if(!active(current)||current.form!==form||current.busy)return true;
    if(current.crop){error(current,'请先确认裁剪。');return true;}
    if(!current.changed)return true;
    current.busy=true;error(current,'');sync(current);
    try {
      const body={version:current.version,image:current.image,...(current.kind==='organization'?{tenantId:current.id}:{accountId:current.id})};
      const data=await request(current.kind==='organization'?'/api/organization/avatar':'/api/team/avatar',body);
      if(!active(current))return true;
      await onSaved(data);closeOverlay();toast('头像已保存。');
    }catch(failure){error(current,failure.status===409?'头像已被更新，请关闭后刷新，再重新上传。':failure.message||'保存失败，请重试。');}
    finally{current.busy=false;sync(current);}
    return true;
  }
  return {open,handleAction,handleSubmit,dispose};
}
