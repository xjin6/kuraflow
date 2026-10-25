import {t, tx, ta, translatedError, setI18nText} from "../../i18n/index.js";
import {storeDirectoryCard,storeCardAddress} from '../../ui/directory-card.js';
import { PREFECTURES, getMunicipalities, getWards, resolveJapanAddress } from '../../shared/japan-addresses.js';

export function createStoreUI(ctx) {
  const { model, ui, isCloud, escape: esc, icon, button, titleHeading, modal, storeAvatar, closeOverlay, render, toast } = ctx;
  const options = (rows, selected = '') => rows.map(row => `<option value="${esc(row.code)}" ${row.code === selected ? 'selected' : ''}>${esc(row.name)}</option>`).join('');
  const field = (label, name, attrs, value = '') => `<div class="field"><label for="store-${name}">${tx(label)}</label><input class="input" id="store-${name}" name="${name}" value="${esc(value)}" ${attrs}></div>`;
  const personalAccounts = Boolean(ctx.personalAccounts), canReadMaster = !isCloud || ctx.canManageAccounts;
  const codeCache = new Map(), codeRequests = new Map();
  let draft = null;
  const copyIcon = id => `<button type="button" class="icon-button store-code-copy-icon" data-action="copy-store-code" data-id="${esc(id)}" ${ta("aria-label", "复制门店识别码")} ${ta("title", "复制识别码")}>${icon('copy')}</button>`;

  function storesPage() {
    const stores = model.getStores().filter(store => [store.name, store.city, store.address, store.contact].join(' ').toLowerCase().includes(ui.query.toLowerCase()));
    if (isCloud && canReadMaster) queueMicrotask(() => stores.filter(store => !store.accessCode && !codeCache.has(store.id)).forEach(store => {
      resolveCode(store).then(code => {
        document.querySelectorAll('[data-store-code]').forEach(node => { if (node.dataset.storeCode === store.id) node.textContent = code; });
      }).catch(() => {
        document.querySelectorAll('[data-store-code]').forEach(node => { if (node.dataset.storeCode === store.id) setI18nText(node, () => t("暂未加载"), "textContent"); });
      });
    }));
    return ctx.managementHeading('stores', 'stores', button((personalAccounts ? tx("新建门店") : tx("新建门店账号")), 'add-store', 'primary', '', 'plus')) +
      `<div class="stores-grid">${(stores.map(s => storeDirectoryCard({
        attributes:`data-store-card="${esc(s.id)}"`,
        title:esc(s.name),
        subtitle:esc(storeCardAddress(s)),
        image:storeAvatar(s),
        status:`<span class="status-badge delivered"><i></i>${tx("已启用")}</span>`,
        tools:'',
        details:`<div><span>${tx("联系人")}</span><strong>${esc((s.contact || t("待填写")))}</strong></div><div><span>${tx("联系电话")}</span><strong>${esc((s.phone || t("待填写")))}</strong></div>${(canReadMaster && (s.accessCode || isCloud) ? `<div class="store-code-row"><span>${tx("负责人码")}</span><div class="store-code-control"><code class="store-code-value" data-store-code="${esc(s.id)}">${esc((s.accessCode || codeCache.get(s.id) || t("加载中…")))}</code>${copyIcon(s.id)}</div></div>` : '')}<div><span>${tx("报价方案")}</span>${(ctx.pricingPicker?.(s) || `<strong>${tx("独立报价")}</strong>`)}</div><div><span>${tx("合作订单")}</span><strong>${tx("{0} 笔", [model.state.orders.filter(o => o.storeId === s.id).length])}</strong></div>`,
        actions:button(tx("编辑"), 'edit-store', 'secondary', `data-id="${esc(s.id)}"`, 'edit')+button(tx("结算"), 'store-settlement', 'secondary', `data-id="${esc(s.id)}"`, 'wallet')+button(tx("报价"), 'store-prices', 'secondary', `data-id="${esc(s.id)}"`, 'tag')
      })).join('') || `<div class="empty-state"><h3>${tx("暂无门店")}</h3></div>`)}</div>`;
  }

  function imageEditor(image) {
    return `<div class="field field-full store-photo-field"><label>${tx("门店图片")}</label><div class="store-photo-upload"><div class="store-photo-preview" id="store-photo-preview">${(image ? `<img src="${esc(image)}" ${ta("alt", "门店图片预览")}>` : icon('store'))}</div><div class="store-photo-controls"><div class="store-photo-actions">${button((image ? tx("更换图片") : tx("上传图片")), 'store-image-upload', 'secondary', 'type="button"')}${button(tx("裁剪"), 'store-image-crop', 'ghost', `type="button" ${image ? '' : 'hidden'}`)}${button(tx("移除"), 'store-image-remove', 'ghost', `type="button" ${image ? '' : 'hidden'}`)}</div><span class="store-photo-format">${tx("正方形 · JPG / PNG / WebP · 最大 5 MB")}</span></div><input id="store-image-file" type="file" accept="image/png,image/jpeg,image/webp" hidden ${ta("aria-label", "上传门店图片")}></div><div class="store-crop-editor" id="store-crop-editor" hidden><div class="store-crop-heading"><strong>${tx("裁剪为正方形")}</strong><span>${tx("拖动调整位置")}</span></div><canvas class="store-crop-canvas" id="store-crop-canvas" width="512" height="512" tabindex="0" role="img" ${ta("aria-label", "门店图片裁剪预览，可拖动或使用方向键调整位置")}></canvas><label class="store-crop-zoom" for="store-crop-zoom"><span>${tx("缩放")}</span><input id="store-crop-zoom" ${ta("aria-label", "缩放")} type="range" min="1" max="3" step="0.01" value="1"><output id="store-crop-scale">100%</output></label><div class="store-crop-actions">${button(tx("取消裁剪"), 'store-image-cancel', 'secondary', 'type="button"')}${button(tx("应用裁剪"), 'store-image-apply', 'primary', 'type="button"')}</div></div><div class="inline-editor-feedback" id="store-photo-error" role="alert"></div></div>`;
  }

  function addressValues(store = {}) {
    let remaining = String(store.address || '').trim();
    const cityName = String(store.city || '').trim().replaceAll('户', '戸').replaceAll('东', '東').replace(/市$/, '');
    let prefecture = PREFECTURES.find(row => row.code === String(store.prefectureCode || '').padStart(2, '0'))
      || PREFECTURES.find(row => row.name === store.prefecture || remaining.startsWith(row.name));
    // Older records may contain only a city name; use it only when unambiguous.
    if (!prefecture && cityName) {
      const matches = PREFECTURES.filter(pref => getMunicipalities(pref.code).some(row => row.name.endsWith('市') && row.name.slice(0, -1) === cityName));
      if (matches.length === 1) prefecture = matches[0];
    }
    if (prefecture && remaining.startsWith(prefecture.name)) remaining = remaining.slice(prefecture.name.length).trim();
    const municipalities = getMunicipalities(prefecture?.code);
    const municipality = municipalities.find(row => row.code === String(store.municipalityCode || '').padStart(5, '0'))
      || municipalities.find(row => row.name === store.municipality || row.name === store.city || remaining.startsWith(row.name))
      || municipalities.find(row => row.name.endsWith('市') && row.name.slice(0, -1) === cityName);
    if (municipality && remaining.startsWith(municipality.name)) remaining = remaining.slice(municipality.name.length).trim();
    const wards = getWards(prefecture?.code, municipality?.code);
    const ward = wards.find(row => row.code === String(store.wardCode || '').padStart(5, '0'))
      || wards.find(row => row.name === store.ward || remaining.startsWith(row.name));
    if (ward && remaining.startsWith(ward.name)) remaining = remaining.slice(ward.name.length).trim();
    return { prefectureCode: prefecture?.code || '', municipalityCode: municipality?.code || '', wardCode: ward?.code || '', addressDetail: store.addressDetail || remaining };
  }

  function addressFields(address) {
    const municipalities = getMunicipalities(address.prefectureCode), wards = getWards(address.prefectureCode, address.municipalityCode);
    return `<div class="field-full store-address-selects"><div class="field"><label for="store-prefecture">${tx("都道府县")}</label><select class="input" id="store-prefecture" name="prefectureCode" required><option value="">${tx("请选择都道府县")}</option>${options(PREFECTURES, address.prefectureCode)}</select></div><div class="field"><label for="store-municipality">${tx("市区町村")}</label><select class="input" id="store-municipality" name="municipalityCode" required ${address.prefectureCode ? '' : 'disabled'}><option value="">${(address.prefectureCode ? tx("请选择市区町村") : tx("请先选择都道府县"))}</option>${options(municipalities, address.municipalityCode)}</select></div><div class="field" id="store-ward-field" ${wards.length ? '' : 'hidden'}><label for="store-ward">${tx("行政区")}</label><select class="input" id="store-ward" name="wardCode" ${wards.length ? 'required' : 'disabled'}><option value="">${tx("请选择行政区")}</option>${options(wards, address.wardCode)}</select></div></div><div class="field field-full"><label for="store-address-detail">${tx("具体地址")}</label><textarea class="input" id="store-address-detail" name="addressDetail" required rows="2" maxlength="180" autocomplete="street-address" ${ta("placeholder", "町名、丁目、番地、楼名及房间号")}>${esc(address.addressDetail)}</textarea><p class="address-preview" id="store-address-preview" aria-live="polite" hidden></p></div>`;
  }

  function openForm(store = null) {
    if (store?.deletedAt) throw new Error('该门店已删除。');
    draft = { storeId: store?.id || '', image: store?.image || '', sourceImage: null, crop: null, loading: false };
    const address = addressValues(store || {});
    modal((store ? tx("编辑门店") : (personalAccounts ? tx("新建门店") : tx("新建门店账号"))), `<div class="form-grid store-create-grid"><div class="field-full store-identity-fields">${imageEditor(draft.image)}<div class="field"><label for="store-name">${tx("门店名称")}</label><input class="input" id="store-name" name="name" value="${esc(store?.name)}" required maxlength="60" autocomplete="organization" ${ta("placeholder", "例如：杨国福大阪难波店")}></div></div>${addressFields(address)}${field(tx("联系人"), 'contact', `required maxlength="30" autocomplete="name" placeholder="门店负责人姓名"`, store?.contact === '待录入' ? '' : store?.contact)}${field(tx("联系电话"), 'phone', `type="tel" inputmode="tel" required maxlength="24" autocomplete="tel" placeholder="例如：090-1234-5678"`, store?.phone)}${(store && canReadMaster ? `<div class="field field-full store-edit-code"><label>${tx("负责人码")}</label><div><code data-store-code="${esc(store.id)}">${esc((store.accessCode || codeCache.get(store.id) || t("加载中…")))}</code>${copyIcon(store.id)}</div></div>` : '')}</div><div class="inline-editor-feedback" id="store-form-error" role="alert"></div>${(store ? `<div class="store-delete-confirm" id="store-delete-confirm" hidden><strong>${tx("删除“{0}”？", [esc(store.name)])}</strong><p>${tx("删除后门店账号将停用，历史订单与账单保留。")}</p><div>${button(tx("保留门店"), 'cancel-delete-store', 'secondary', 'type="button"')}${button(tx("确认删除"), 'confirm-delete-store', 'danger', `type="button" data-id="${esc(store.id)}"`, 'trash')}</div><div id="store-delete-error" class="inline-editor-feedback" role="alert"></div></div>` : '')}`, (store ? button(tx("删除门店"), 'delete-store', 'danger', 'type="button"', 'trash') : '') + button(tx("取消"), 'close', 'secondary', 'type="button"') + `<button type="submit" class="btn btn-primary">${(store ? tx("保存修改") : (personalAccounts ? tx("创建门店") : tx("创建账号")))}</button>`, 'store-form');
    const form = document.querySelector('#store-form');
    form.dataset.storeId = store?.id || '';
    updateAddress(form.elements.addressDetail);
    form.closest('.modal').classList.add('store-form-modal');
    form.querySelector('#store-image-file').addEventListener('change', event => selectImage(event.target));
    form.querySelector('#store-crop-zoom').addEventListener('input', event => {
      if (!draft?.crop) return;
      draft.crop.zoom = Number(event.target.value); drawCrop();
    });
    bindCropCanvas(form.querySelector('#store-crop-canvas'));
    if (store && canReadMaster && !store.accessCode && isCloud) resolveCode(store).then(code => {
      if (form.isConnected) form.querySelector('[data-store-code]').textContent = code;
    }).catch(() => { if (form.isConnected) setI18nText(form.querySelector('[data-store-code]'), () => t("暂未加载"), "textContent"); });
  }
  function openCreate() { openForm(); }
  function openEdit(id) {
    const store = model.getStore(id);
    if (!store) throw new Error('未找到门店。');
    openForm(store);
  }

  function updateAddress(input) {
    const form = input.closest('#store-form');
    if (!form || !['prefectureCode', 'municipalityCode', 'wardCode', 'addressDetail'].includes(input.name)) return false;
    const prefecture = form.elements.prefectureCode, municipality = form.elements.municipalityCode, ward = form.elements.wardCode;
    if (input === prefecture) {
      municipality.innerHTML = `<option value="">${(prefecture.value ? tx("请选择市区町村") : tx("请先选择都道府县"))}</option>` + options(getMunicipalities(prefecture.value));
      municipality.disabled = !prefecture.value;
      ward.innerHTML = `<option value="">${tx("请选择行政区")}</option>`;
      ward.disabled = true; ward.required = false; form.querySelector('#store-ward-field').hidden = true;
    }
    if (input === municipality) {
      const wards = getWards(prefecture.value, municipality.value);
      ward.innerHTML = `<option value="">${tx("请选择行政区")}</option>` + options(wards);
      ward.disabled = !wards.length; ward.required = !!wards.length;
      form.querySelector('#store-ward-field').hidden = !wards.length;
    }
    const selected = [prefecture, municipality, ward].filter(select => !select.disabled && select.value).map(select => select.selectedOptions[0].textContent);
    const detail = form.elements.addressDetail.value.trim(), preview = form.querySelector('#store-address-preview');
    preview.textContent = selected.join('') + detail; preview.hidden = !preview.textContent;
    form.querySelector('#store-form-error').textContent = '';
    return true;
  }

  async function createStore(form, data) {
    try {
      if (!draft || draft.loading || draft.crop) throw new Error('请先应用或取消图片裁剪。');
      const phone = String(data.phone || '').trim();
      if (phone && (!/^[+\d\s()（）ー−-]{7,24}$/.test(phone) || phone.replace(/\D/g, '').length < 7)) throw new Error('请填写有效的联系电话，例如 090-1234-5678。');
      const divisions = resolveJapanAddress(data), detail = String(data.addressDetail || '').trim();
      const name = String(data.name || '').trim(), contact = String(data.contact || '').trim();
      if (!name || !detail || !contact || !phone) throw new Error('请完整填写门店名称、具体地址、联系人和联系电话。');
      const values = { name, contact, phone, image: draft.image || null, ...divisions,
        prefectureCode: data.prefectureCode, municipalityCode: data.municipalityCode, wardCode: data.wardCode || '',
        addressDetail: detail, city: divisions.municipality,
        address: [divisions.prefecture, divisions.municipality, divisions.ward, detail].filter(Boolean).join('') };
      let store;
      if (form.dataset.storeId) {
        const current = model.getStore(form.dataset.storeId);
        if (!current || current.deletedAt) throw new Error('该门店已删除。');
        store = await model.updateStore(current.id, values);
        closeOverlay(); render(); toast('门店信息已保存。');
      } else {
        store = await model.addStore(values);
        ui.quoteStore = store.id;
        closeOverlay(); render();
        if (store.accessCode) codeCache.set(store.id, store.accessCode);
        toast(personalAccounts?'门店已创建，可复制负责人码登录。':'门店账号已创建。');
      }
      draft = null;
      return store;
    } catch (error) {
      form.querySelector('#store-form-error').textContent = translatedError(error.message);
      throw error;
    }
  }

  function setPhotoBusy(form, busy) {
    if (!form?.isConnected) return;
    form.querySelector('[type="submit"]').disabled = busy;
    form.querySelectorAll('[data-action="store-image-upload"], [data-action="store-image-crop"], [data-action="store-image-remove"]').forEach(button => { button.disabled = busy; });
  }
  async function selectImage(input) {
    const file = input.files?.[0], form = input.closest('form'), currentDraft = draft;
    input.value = '';
    if (!file || !currentDraft) return;
    const errorNode = form.querySelector('#store-photo-error');
    errorNode.textContent = '';
    try {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
      if (file.size > 5 * 1024 * 1024) throw new Error('图片不能超过 5 MB。');
      currentDraft.loading = true; setPhotoBusy(form, true);
      const url = URL.createObjectURL(file), image = new Image();
      try { image.src = url; await image.decode(); } finally { URL.revokeObjectURL(url); }
      if (!form.isConnected || currentDraft !== draft) return;
      if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40000000) throw new Error('图片尺寸过大，请使用 4000 万像素以内的图片。');
      beginCrop(image);
    } catch (error) { if (form.isConnected) { setI18nText(errorNode, () => (translatedError(error.message) || t("无法读取图片，请重新选择。")), "textContent"); setPhotoBusy(form, false); } }
    finally { currentDraft.loading = false; }
  }
  async function recropImage() {
    if (!draft?.image) return;
    if (draft.sourceImage) { beginCrop(draft.sourceImage); return; }
    const form = document.querySelector('#store-form'), currentDraft = draft, image = new Image();
    currentDraft.loading = true; setPhotoBusy(form, true);
    try {
      image.src = draft.image; await image.decode();
      if (!form.isConnected || currentDraft !== draft) return;
      beginCrop(image);
    } catch { setPhotoBusy(form, false); throw new Error('无法读取门店图片，请重新上传。'); }
    finally { currentDraft.loading = false; }
  }
  function beginCrop(image) {
    const form = document.querySelector('#store-form');
    draft.crop = { image, zoom: 1, x: 0.5, y: 0.5 };
    form.querySelector('#store-crop-editor').hidden = false;
    form.querySelector('#store-crop-zoom').value = '1';
    setPhotoBusy(form, true); drawCrop();
    form.querySelector('#store-crop-canvas').focus({ preventScroll: true });
    form.querySelector('#store-crop-editor').scrollIntoView({ block: 'nearest' });
  }
  function cropBounds(crop) {
    const side = Math.min(crop.image.naturalWidth, crop.image.naturalHeight) / crop.zoom;
    return { side, x: (crop.image.naturalWidth - side) * crop.x, y: (crop.image.naturalHeight - side) * crop.y };
  }
  function drawCrop() {
    if (!draft?.crop) return;
    const canvas = document.querySelector('#store-crop-canvas'), ctx = canvas.getContext('2d'), crop = draft.crop;
    const { side, x, y } = cropBounds(crop);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(crop.image, x, y, side, side, 0, 0, canvas.width, canvas.height);
    document.querySelector('#store-crop-scale').textContent = `${Math.round(crop.zoom * 100)}%`;
  }
  function bindCropCanvas(canvas) {
    let pointer = null;
    const clamp = value => Math.max(0, Math.min(1, value));
    canvas.addEventListener('pointerdown', event => {
      if (!draft?.crop) return;
      pointer = { x: event.clientX, y: event.clientY };
      canvas.setPointerCapture(event.pointerId); event.preventDefault();
    });
    canvas.addEventListener('pointermove', event => {
      if (!pointer || !draft?.crop) return;
      const crop = draft.crop, { side } = cropBounds(crop), size = canvas.getBoundingClientRect().width;
      const width = crop.image.naturalWidth - side, height = crop.image.naturalHeight - side;
      if (width) crop.x = clamp(crop.x - (event.clientX - pointer.x) * side / size / width);
      if (height) crop.y = clamp(crop.y - (event.clientY - pointer.y) * side / size / height);
      pointer = { x: event.clientX, y: event.clientY }; drawCrop();
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(type => canvas.addEventListener(type, () => { pointer = null; }));
    canvas.addEventListener('keydown', event => {
      if (!draft?.crop || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const axis = ['ArrowLeft', 'ArrowRight'].includes(event.key) ? 'x' : 'y';
      draft.crop[axis] = clamp(draft.crop[axis] + (['ArrowRight', 'ArrowDown'].includes(event.key) ? .025 : -.025)); drawCrop();
    });
  }
  function endCrop(apply) {
    const form = document.querySelector('#store-form');
    if (apply && draft?.crop) {
      const canvas = form.querySelector('#store-crop-canvas');
      let quality = .9, image = canvas.toDataURL('image/webp', quality);
      while (image.length > 260000 && quality > .35) { quality -= .1; image = canvas.toDataURL('image/webp', quality); }
      if (image.length > 260000) throw new Error('图片内容过于复杂，请选择其他图片。');
      draft.image = image;
      draft.sourceImage = draft.crop.image;
    }
    draft.crop = null;
    form.querySelector('#store-crop-editor').hidden = true;
    updatePhotoPreview(); setPhotoBusy(form, false);
  }
  function updatePhotoPreview() {
    const form = document.querySelector('#store-form');
    form.querySelector('#store-photo-preview').innerHTML = draft.image ? `<img src="${esc(draft.image)}" ${ta("alt", "门店图片预览")}>` : icon('store');
    setI18nText(form.querySelector('[data-action="store-image-upload"]'), () => (draft.image ? t("更换图片") : t("上传图片")), "textContent");
    form.querySelectorAll('[data-action="store-image-crop"], [data-action="store-image-remove"]').forEach(button => { button.hidden = !draft.image; });
    form.querySelector('#store-photo-error').textContent = '';
  }

  async function handleAction(action, el) {
    const actions = ['edit-store', 'delete-store', 'cancel-delete-store', 'confirm-delete-store', 'store-image-upload', 'store-image-crop', 'store-image-remove', 'store-image-cancel', 'store-image-apply'];
    if (!actions.includes(action)) return false;
    if (ui.role !== 'admin') throw new Error('此操作仅供中央厨房管理员使用。');
    if (action === 'edit-store') openEdit(el.dataset.id);
    if (action === 'store-image-upload') document.querySelector('#store-image-file').click();
    if (action === 'store-image-crop') await recropImage();
    if (action === 'store-image-cancel') endCrop(false);
    if (action === 'store-image-apply') endCrop(true);
    if (action === 'store-image-remove') { draft.image = ''; draft.sourceImage = null; updatePhotoPreview(); }
    if (action === 'delete-store' || action === 'cancel-delete-store') {
      const panel = document.querySelector('#store-delete-confirm');
      panel.hidden = action === 'cancel-delete-store';
      if (!panel.hidden) { panel.scrollIntoView({ block: 'nearest' }); panel.querySelector('[data-action="confirm-delete-store"]').focus({ preventScroll: true }); }
    }
    if (action === 'confirm-delete-store') {
      const form = document.querySelector('#store-form');
      el.disabled = true;
      try {
        await model.deleteStore(el.dataset.id);
        if (ui.quoteStore === el.dataset.id) ui.quoteStore = model.state.stores.find(store => !store.deletedAt)?.id || '';
        draft = null; closeOverlay(); render(); toast('门店已删除。');
      } catch (error) { if (form?.isConnected) { form.querySelector('#store-delete-error').textContent = translatedError(error.message); el.disabled = false; } throw error; }
    }
    return true;
  }

  async function resolveCode(store) {
    if (!store || store.deletedAt) throw new Error('未找到门店。');
    if (store.accessCode) return store.accessCode;
    if (codeCache.has(store.id)) return codeCache.get(store.id);
    if (!isCloud) throw new Error('未找到门店识别码。');
    if (!codeRequests.has(store.id)) codeRequests.set(store.id, model.getStoreAccessCode(store.id).then(code => { codeCache.set(store.id, code); return code; }).finally(() => codeRequests.delete(store.id)));
    return codeRequests.get(store.id);
  }
  async function showCode(store, created = false) {
    const accessCode = await resolveCode(store);
    modal((created ? tx("门店账号已创建") : tx("门店识别码")), `<div class="store-code-result"><div class="store-code-store">${storeAvatar(store)}<div><h3>${esc(store.name)}</h3><p>${esc((store.contact || ''))}${(store.phone ? ' · ' + esc(store.phone) : '')}</p></div></div><label class="small-label" for="store-access-code">${tx("门店识别码")}</label><input class="store-access-code" id="store-access-code" value="${esc(accessCode)}" readonly ${ta("aria-label", "门店识别码")} spellcheck="false">${(created ? `<div class="store-created-address">${icon('pin')}<span>${esc(store.address)}</span></div>` : '')}</div>`, button(tx("完成"), 'close', 'secondary') + button(tx("复制识别码"), 'copy-store-code', 'primary', `data-id="${esc(store.id)}"`));
  }
  async function copyCode(id) {
    const store = model.getStore(id), accessCode = await resolveCode(store);
    try { await navigator.clipboard.writeText(accessCode); toast('门店识别码已复制。'); }
    catch {
      const code = document.querySelector('#store-form [data-store-code]');
      if (code) { const range = document.createRange(); range.selectNodeContents(code); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); toast('请复制已选中的识别码。'); }
      else { await showCode({ ...store, accessCode }); const input = document.querySelector('#store-access-code'); input.focus(); input.select(); toast('请复制已选中的识别码。'); }
    }
  }
  function dispose() { draft = null; }
  return { storesPage, openCreate, openEdit, updateAddress, createStore, showCode, copyCode, handleAction, dispose };
}
