import { KitchenModel } from './data.js';

export const isCloud = Boolean(globalThis.__KURAFLOW_SESSION__);
export const principal = globalThis.__KURAFLOW_SESSION__?.principal || null;

export function imageDataBlob(data) {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(data);
  if (!match) throw new Error('图片格式不正确，请重新选择图片。');
  const bytes = Uint8Array.from(atob(match[2]), character => character.charCodeAt(0));
  return new Blob([bytes], { type: match[1] });
}

export async function cloudRequest(path, body, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store',
      ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      ...options,
    });
  } catch {
    throw new Error('网络连接中断，请检查网络后重试。');
  }
  let data;
  try { data = await response.json(); }
  catch {
    // An interrupted success response must remain retryable with the original
    // command key; treating it as success can duplicate a saved store/order.
    if (response.ok) throw new Error('服务器响应未完整接收，请重试。');
    data = {};
  }
  if (!response.ok) {
    if (response.status === 401 && isCloud) {
      window.dispatchEvent(new CustomEvent('kuraflow-session-expired'));
    }
    const error = new Error(data.error || '操作未完成，请稍后重试。');
    error.status = response.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

export function createCloudModel(session) {
  const model = Object.create(KitchenModel.prototype);
  const draftKey = `kuraflow-draft:${session.principal.tenantId}:${session.principal.userId}`;
  let storage = null;
  try { storage = window.localStorage; } catch { /* Drafts can live in memory. */ }
  let draft = {};
  try { draft = JSON.parse(storage?.getItem(draftKey) || '{}'); } catch { /* Ignore damaged drafts. */ }
  model.pending = 0;
  model.revision = session.revision;
  model.state = session.state;
  const apply = snapshot => {
    model.reportHistoryReady = snapshot.orders.filter(order=>order.stage==='delivered').length<100;
    model.reportHistoryError = '';
    const previous = model.state || {};
    model.state = { ...snapshot, cart: previous.cart || {}, cartUnits: previous.cartUnits || {},
      cartNote: previous.cartNote || '', cartDeliveryDate: previous.cartDeliveryDate || '',
      activeStoreId: session.principal.role === 'store' ? session.principal.storeId : previous.activeStoreId || snapshot.activeStoreId || snapshot.stores[0]?.id || '' };
    // Completed records are immutable. Keep fetched history reachable in an
    // open detail page while the next revision's reporting pages are loading.
    const orderIds=new Set(snapshot.orders.map(order=>order.id));
    model.state.orders=[...snapshot.orders,...(previous.orders||[]).filter(order=>order.stage==='delivered'&&!orderIds.has(order.id))];
    const productIds=new Set(snapshot.products.map(product=>product.id));
    model.state.products=[...snapshot.products,...(previous.products||[]).filter(product=>!productIds.has(product.id)).map(product=>({...product,catalogueHidden:true,basePrice:null,stock:0}))];
    if (!model.getStores().some(s => s.id === model.state.activeStoreId)) {
      model.state.activeStoreId = model.getStores()[0]?.id || '';
      model.state.cart = {}; model.state.cartUnits = {}; model.state.cartNote = '';
    }
    for (const id of Object.keys(model.state.cart)) {
      if (!model.getProduct(id) || model.getProduct(id).deletedAt) { delete model.state.cart[id]; delete model.state.cartUnits[id]; }
    }
    if (session.principal.role === 'store') model.normalizeStoreCart(session.principal.storeId);
  };
  model.state = { ...session.state, ...draft };
  apply(session.state);
  model.save = () => {
    const { cart, cartUnits, cartNote, cartDeliveryDate, activeStoreId } = model.state;
    try { storage?.setItem(draftKey, JSON.stringify({ cart, cartUnits, cartNote, cartDeliveryDate, activeStoreId })); } catch { /* Server records are already persisted. */ }
    return model.state;
  };
  model.reset = () => { throw new Error('线上业务数据不能恢复为演示数据。'); };
  const keys = new Map(), pending = new Map();
  let queue = Promise.resolve();
  model.command = (type, args, extra = {}) => {
    // Reuse the key on a network retry so one click cannot create two orders.
    const fingerprint = JSON.stringify({ type, args, ...extra });
    if (pending.has(fingerprint)) return pending.get(fingerprint);
    const idempotencyKey = keys.get(fingerprint) || crypto.randomUUID();
    keys.set(fingerprint, idempotencyKey);
    model.pending++;
    const operation = queue.catch(() => {}).then(async () => {
      try {
        const data = await cloudRequest('/api/commands', { type, args, idempotencyKey, ...extra });
        if (data.state) apply(data.state);
        model.revision = data.revision ?? model.revision;
        keys.delete(fingerprint);
        model.save();
        return data.result;
      } catch (error) {
        if (error.status && error.status < 500) keys.delete(fingerprint);
        if (error.status === 409) {
          const current = await cloudRequest('/api/state');
          apply(current.state); model.revision = current.revision;
          window.dispatchEvent(new CustomEvent('kuraflow-state-changed'));
        }
        throw error;
      }
    }).finally(() => { model.pending--; pending.delete(fingerprint); });
    queue = operation;
    pending.set(fingerprint, operation);
    return operation;
  };
  for (const type of ['setWarehouseStock', 'setWarehouseUnitStock', 'setStoreUnitAllocation', 'setStoreAllocation', 'setUnitQuote', 'setSaleUnits', 'setSaleUnitEquations', 'setPrice', 'deleteStore', 'setStock', 'packLine', 'confirmPackLine', 'setStage', 'remindOrder', 'recordIssue', 'confirmDelivery', 'importProducts', 'deleteProduct', 'restoreProduct']) {
    model[type] = (...args) => model.command(type, args);
  }
  model.getStoreAccessCode = async storeId => (await cloudRequest('/api/admin/store-code',{storeId})).accessCode;
  const uploadedImages = new Map();
  const withUploadedImage = async value => {
    const data = { ...value };
    if (data.image?.startsWith('data:')) {
      const image = imageDataBlob(data.image);
      if (image.size > 200 * 1024) throw new Error('压缩后的图片仍大于 200 KB，请选择更小的图片。');
      const digest = await crypto.subtle.digest('SHA-256', await image.arrayBuffer());
      const fingerprint = image.type + ':' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      // Keep only the digest and URL, not image contents. Reusing the uploaded
      // URL preserves command identity when a committed save needs a retry.
      let upload = uploadedImages.get(fingerprint);
      if (!upload) {
        upload = cloudRequest('/api/images', undefined, { method: 'POST', headers: { 'Content-Type': image.type }, body: image })
          .then(result => result.url)
          .catch(error => { uploadedImages.delete(fingerprint); throw error; });
        uploadedImages.set(fingerprint, upload);
      }
      data.image = await upload;
    }
    return data;
  };
  model.addProduct = async product => model.command('addProduct', [await withUploadedImage(product)]);
  model.addStore = async store => model.command('addStore', [await withUploadedImage(store)]);
  model.updateStore = async (storeId, store) => model.command('updateStore', [storeId, await withUploadedImage(store)]);
  model.submitOrder = async (storeId, cart, date, note) => {
    const units = { ...model.state.cartUnits };
    const expectedQuotes = Object.fromEntries(Object.keys(cart).filter(id => Number(cart[id]) > 0).map(id => {
      const unit = model.getCartUnit(id), quote = model.getUnitQuote(storeId, id, unit);
      units[id] = unit;
      return [id, { unit, price: quote.price, taxBasis: quote.taxBasis, taxRate: quote.taxRate, perBase: model.getUnitFactor(id, unit) }];
    }));
    const result = await model.command('submitOrder', [storeId, { ...cart }, date, note, units], { expectedQuotes });
    model.state.cart = {}; model.state.cartUnits = {}; model.state.cartNote = ''; model.save();
    return result;
  };
  model.refresh = async () => {
    if (model.pending) return false;
    const before = model.revision;
    const data = await cloudRequest('/api/state');
    // A command might have begun while the refresh request was in flight.
    if (model.pending || model.revision !== before) return false;
    if (data.revision === model.revision) return false;
    apply(data.state); model.revision = data.revision;
    return true;
  };
  let historyTask=null;
  model.loadReportHistory = () => {
    if (historyTask) return historyTask;
    if (model.reportHistoryReady) return Promise.resolve();
    const revision=model.revision;
    model.reportHistoryError='';
    historyTask=(async()=>{
      const orders=[],products=new Map();let cursor=0;
      do {
        const page=await cloudRequest(`/api/order-history?revision=${revision}&cursor=${cursor}`);
        if (model.revision!==revision || model.pending) return;
        orders.push(...page.orders);for(const product of page.products||[])products.set(product.id,product);cursor=page.nextCursor;
      } while(cursor!==null);
      model.state.orders=[...model.state.orders.filter(order=>order.stage!=='delivered'),...orders];
      const knownProducts=new Set(model.state.products.map(product=>product.id));
      model.state.products.push(...[...products.values()].filter(product=>!knownProducts.has(product.id)));
      model.reportHistoryReady=true;
    })().catch(async error=>{
      if(model.revision!==revision)return;
      if(error.code==='HISTORY_CHANGED') {try {await model.refresh();} catch(refreshError) {model.reportHistoryError=refreshError.message;return;}}
      model.reportHistoryError=error.message;
    }).finally(()=>{historyTask=null;});
    return historyTask;
  };
  return model;
}
