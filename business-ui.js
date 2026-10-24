import { company, materialSummary, materialCosts, procurementAttachment } from './business-data.js';
import { SALE_UNIT_OPTIONS } from './data.js';

export function createBusinessUI(ctx) {
  const { isCloud, model, ui, money, escape: esc, icon, button, titleHeading, clientStoreSelect, cartPanel, qtyControl, cartTotal, cartItems, mobileCartBar, emptyState, modal, activeStore, clientStoreHeader } = ctx;
  const sourceUrl = (source) => source ? '/' + String(source).replace(/^\//, '') : '';
  const sourceName = (source) => typeof source === 'string' ? source.split('/').at(-1) : source?.file || '管理员录入';
  const sourceLink = (source, label = '查看原始资料') => !isCloud && typeof source === 'string' && source.startsWith('materials/') ? `<a class="btn btn-secondary" href="${encodeURI(sourceUrl(source))}" target="_blank" rel="noopener">${icon('download')}${esc(label)}</a>` : '';
  const taxLabel = (quote) => quote.taxBasis === 'exclusive' ? '未税' + (quote.taxRate !== null ? ' · ' + quote.taxRate * 100 + '%' : '') : quote.taxBasis === 'inclusive' ? '含税' : '税率待确认';
  const stockText = (p) => { const unit = ui.role === 'admin' ? p.unit : model.getCartUnit(p.id); const n = ui.role === 'admin' ? model.getStock(p.id) : model.getUnitOrderableStock(activeStore().id,p.id,unit); return n === null ? (model.isStockUnlimited(p.id)?'无限':'待确认') : stockQuantityText(n, unit); };
  const quote = (p, storeId = activeStore().id) => { const q = ui.role === 'client' ? model.getUnitQuote(storeId,p.id,model.getCartUnit(p.id)) : model.getQuote(storeId,p.id); return { ...q, kind: q.kind === 'manual' ? '管理员设置' : q.kind === 'reference' ? '销售报价参考' : q.kind === 'unquoted' ? '尚待报价' : q.kind }; };
  const amount = (p, qty, storeId = activeStore().id) => quote(p, storeId).price === null ? '待报价' : money(Math.round(qty * quote(p, storeId).price * 100) / 100);
  const catalogueProducts = () => ui.role === 'client' ? model.getOrderableProducts(activeStore().id) : model.getProducts();
  const filtered = () => catalogueProducts().filter(p => (ui.category === '全部商品' || p.category === ui.category) && (p.name + p.spec + p.sku).toLowerCase().includes(ui.query.toLowerCase()));
  const chips = () => `<div class="category-chips">${['全部商品', ...catalogueProducts().map(p => p.category).filter((c, i, arr) => arr.indexOf(c) === i)].map(c => `<button class="chip ${ui.category === c ? 'active' : ''}" data-action="category" data-category="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;

  function productCost(p) {
    if(Object.hasOwn(p,'costPrice'))return {price:p.costPrice,source:''};
    const normalize=value=>String(value||'').toLowerCase().replace(/\s/g,'');
    const candidates=materialCosts.filter(row=>p.costReferences?.includes(row.productCode)&&normalize(row.unit)===normalize(p.unit)&&Number.isFinite(row.costPrice)&&!row.costRange&&!row.flags?.some(flag=>flag.includes('conflict'))&&(p.unit==='KG'||normalize(row.spec)===normalize(p.spec)));
    return candidates.length===1?{price:candidates[0].costPrice,source:'原成本表'+(candidates[0].taxBasis==='exclusive'?' · 未税':'')}:{price:null,source:''};
  }
  function sourceBanner() {
    if (isCloud) return `<div class="materials-banner">${icon('clipboard')}<div><strong>云端业务工作台</strong><span>${model.state.products.length} 种商品 · ${model.state.stores.length} 家门店 · ${model.state.orders.length} 笔订单，操作保存后同步到云端。</span></div><button class="text-button" data-page="materials">资料核对 ${icon('arrow')}</button></div>`;
    return `<div class="materials-banner">${icon('clipboard')}<div><strong>现有业务资料已载入</strong><span>${materialSummary.salesCount} 条销售报价 · ${materialSummary.costCount} 条成本记录 · 神户订货样例 · 2 份历史单据。今日配货状态用于演示。</span></div><button class="text-button" data-page="materials">资料核对 ${icon('arrow')}</button></div>`;
  }
  function productName(p, extra = '') {
    return `<button class="product-name-link ${extra}" data-action="price-info" data-id="${p.id}" aria-haspopup="dialog">${esc(p.name)}</button>`;
  }
  function priceInfo(id) {
    const p = model.getProduct(id);
    if (!p) throw new Error('商品不存在。');
    const client = ui.role === 'client';
    const store = client ? activeStore() : model.getStores().find(store => store.id === ui.quoteStore) || model.getStores()[0];
    const units = client ? model.getQuotedSaleUnits(store.id, p.id) : model.getSaleUnits(p.id);
    const equations = model.getSaleUnitEquations(p.id).filter(e => e.fromUnit !== e.toUnit);
    const notes = client ? [] : (p.reviewNotes || []).slice();
    if (!client && p.referencePrice != null) notes.unshift('报价单原值：' + money(p.referencePrice) + ' / ' + p.referenceUnit + '。');
    if (!client && p.conversionNote) notes.unshift('换算依据：' + p.conversionNote + '；来源报价 ' + money(p.referencePrice) + ' / ' + p.referenceUnit + '。');
    const stock = value => value === null ? '未盘点' : stockQuantityText(value, esc(p.unit));
    const inventory = client
      ? [['可订库存', model.getOrderableStock(store.id, p.id) === null ? (model.isStockUnlimited(p.id)?'无限':'待厨房确认') : stock(model.getOrderableStock(store.id, p.id))]]
      : [['公司总库存', model.isStockUnlimited(p.id)?'无限':stock(model.getWarehouseStock(p.id))], ['订单占用', stock(model.getReservedQty(p.id))], ['门店已分配', stock(model.getAllocatedQty(p.id))]];
    const quotes = store ? units.map(u => ({ unit: u.unit, q: model.getUnitQuote(store.id, p.id, u.unit) })) : [];
    const sources = client ? [] : [...new Set(quotes.map(({q}) => q.source).filter(Boolean).map(sourceName))];
    const sourceLinks = client ? '' : [...new Set(quotes.map(({q}) => q.source).filter(source => typeof source === 'string' && source.startsWith('materials/')))].map(source => sourceLink(source, '打开报价原件')).join('');
    modal('商品详情', `<div class="product-detail-header">${p.image ? `<img class="product-detail-image" src="${esc(p.image)}" alt="${esc(p.name)}">` : `<div class="product-detail-image product-detail-placeholder" aria-hidden="true">${icon('box')}</div>`}<div><span class="product-detail-category">${esc(p.category)}</span><h3>${esc(p.name)}</h3><p>${esc(p.spec || '规格未填写')}</p>${p.deletedAt ? '<span class="review-label">已在回收站</span>' : ''}</div></div><section class="product-detail-section"><h3>商品说明</h3><p class="product-detail-description">${esc(p.description || '暂未填写商品说明。')}</p></section><section class="product-detail-section"><h3>单位与库存</h3><div class="product-detail-units">${units.map(u => `<span class="catalogue-unit-pill">${esc(u.unit)}</span>`).join('')}</div><p class="form-hint">${equations.length ? equations.map(e => `<span class="unit-equation-summary">${formatUnitQuantity(e.fromQty)} ${esc(e.fromUnit)} = ${formatUnitQuantity(e.toQty)} ${esc(e.toUnit)}</span>`).join('；') : '库存按' + esc(p.unit) + '记录'}</p><dl class="product-detail-facts">${inventory.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl></section>${store ? `<section class="product-detail-section"><h3>${client ? '单价' : '门店报价 <span>' + esc(store.name) + '</span>'}</h3><div class="product-detail-quotes">${quotes.map(({unit, q}) => `<div class="product-detail-quote"><span>${esc(unit)}</span><strong>${q.price === null ? '待报价' : money(q.price)}</strong><span>${q.price === null ? '—' : taxLabel(q)}</span></div>`).join('')}</div>${sources.length ? `<p class="source-note">报价来源：${esc(sources.join('；'))}</p>` : ''}${sourceLinks ? `<div class="product-detail-source-links">${sourceLinks}</div>` : ''}</section>` : ''}${notes.length ? `<section class="product-detail-section"><h3>待核对信息</h3><ul class="product-detail-notes">${notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}`, button('关闭', 'close', 'secondary'));
    document.querySelector('.modal').classList.add('product-details-modal');
  }
  function unitSelector(p) {
    return `<select class="sale-unit-select" data-cart-unit="${p.id}" aria-label="${esc(p.name)}购买单位">${model.getQuotedSaleUnits(activeStore().id, p.id).map(u => `<option value="${esc(u.unit)}" ${u.unit === model.getCartUnit(p.id) ? 'selected' : ''}>${esc(u.unit)}</option>`).join('')}</select>`;
  }
  function unitQuoteEditor(p, store) {
    const plan=model.getStoreQuotePlan(store.id);if(plan)return `<div class="store-unit-quotes">${model.getSaleUnits(p.id).map(({unit})=>{const q=model.getUnitQuote(store.id,p.id,unit);return `<div class="saved-unit-quote"><strong>${q.price===null?'未报价':money(q.price)} / ${esc(unit)}</strong><span>${q.price===null?'':taxLabel(q)}</span></div>`;}).join('')}<button type="button" class="text-button" data-action="open-quote-plan" data-id="${esc(plan.id)}">编辑 ${esc(plan.name)}</button></div>`;

    const units = model.getSaleUnits(p.id);
    const priced = units.map(u => ({unit:u.unit,quote:model.getUnitQuote(store.id,p.id,u.unit)})).filter(u => u.quote.price !== null);
    return `<div class="store-unit-quotes" data-product="${p.id}" data-store="${store.id}"><div class="saved-unit-quotes">${priced.map(({unit,quote:q}) => `<div class="saved-unit-quote"><div class="saved-unit-price-line"><strong>${money(q.price)}<span> / ${esc(unit)}</span></strong><button class="cell-edit-button edit-icon-button" data-action="edit-unit-quote" data-id="${p.id}" data-store="${store.id}" data-unit="${esc(unit)}" aria-label="编辑${esc(p.name)}${esc(unit)}报价">${icon('edit')}</button></div><span class="saved-quote-tax">${taxLabel(q)}</span></div>`).join('') || '<span class="quote-empty">尚未设置报价</span>'}</div><div data-quote-form-slot></div>${priced.length < units.length ? `<button class="add-quote-button" aria-label="${priced.length ? '添加单位报价' : '添加报价'}" data-action="add-unit-quote" data-id="${p.id}" data-store="${store.id}">${icon('plus')} ${priced.length ? '添加单位报价' : '添加报价'}</button>` : ''}</div>`;
  }
  function openUnitQuoteForm(el, editing = false) {
    const p = model.getProduct(el.dataset.id), store = model.getStore(el.dataset.store);
    const container = el.closest('.store-unit-quotes');
    const unit = editing ? el.dataset.unit : '';
    const q = editing ? model.getUnitQuote(store.id,p.id,unit) : {price:null,taxBasis:'unspecified',taxRate:null};
    const units = model.getSaleUnits(p.id).filter(u => u.unit === unit || model.getUnitQuote(store.id,p.id,u.unit).price === null);
    container.querySelector('[data-quote-form-slot]').innerHTML = `<form class="inline-quote-editor quote-entry" data-inline-kind="quote" data-product="${p.id}" data-store="${store.id}" data-sale-unit="${esc(unit)}"><div class="quote-entry-fields"><label><span>售卖单位</span><select name="quoteUnit" class="input" aria-label="${esc(p.name)}报价单位" required ${editing?'disabled':''}><option value="">选择单位</option>${units.map(u => `<option value="${esc(u.unit)}" ${u.unit===unit?'selected':''}>${esc(u.unit)}</option>`).join('')}</select></label><label><span>单价（日元）</span><input class="input" name="price" type="number" min="0.01" step="0.01" required value="${q.price ?? ''}" placeholder="输入单价" aria-label="${esc(p.name)}单价"></label></div><div class="inline-tax-fields"><select name="taxBasis" aria-label="${esc(p.name)}税口径">${[['unspecified','税率待确认'],['exclusive','未税'],['inclusive','含税']].map(([v,t])=>`<option value="${v}" ${q.taxBasis===v?'selected':''}>${t}</option>`).join('')}</select><input name="taxRate" type="number" min="0" max="100" step="0.01" value="${q.taxRate===null?'':q.taxRate*100}" ${q.taxBasis==='unspecified'?'disabled':''} placeholder="税率" aria-label="${esc(p.name)}税率"><span>%</span></div><div class="quote-entry-actions"><button type="submit" class="catalogue-inline-submit">保存报价</button><button type="button" class="cell-edit-button" data-action="cancel-unit-quote" data-id="${p.id}" data-store="${store.id}">取消</button></div><span class="inline-editor-feedback" role="status"></span></form>`;
    container.querySelectorAll('[data-action="edit-unit-quote"]').forEach(button => button.disabled = true);
    const add = container.querySelector('.add-quote-button'); if (add) add.hidden = true;
    container.querySelector(editing ? '[name=price]' : '[name=quoteUnit]').focus();
  }
  function clientProductsPage() {
    const store = activeStore(), list = filtered(), view = ui.productView || (window.matchMedia('(max-width: 720px)').matches ? 'cards' : 'table');
    return titleHeading('我要订货', '按原订货单品类排列，箱、袋、个与 KG 分开计价。', clientStoreSelect(), '每度商事 / RESTAURANT ORDERING') +
      `<div class="client-banner">${clientStoreHeader(store)}</div>
      <div class="client-order-layout ${view === 'table' ? 'ordering-table-mode' : ''}"><div><div class="ordering-toolbar"><label class="search-box">${icon('search')}<input id="product-search" aria-label="搜索商品" value="${esc(ui.query)}" placeholder="搜索品名、规格或编号"></label><div class="view-switch"><button class="${view === 'table' ? 'active' : ''}" data-action="product-view" data-view="table">${icon('clipboard')} 货单</button><button class="${view === 'cards' ? 'active' : ''}" data-action="product-view" data-view="cards">${icon('grid')} 图片</button></div></div>${chips()}${view === 'table' ? quickOrderTable(list, store) : productCards(list, store)}<div class="notice">${icon('help')} KG 按实际重量订购，运费另计。</div></div>${cartPanel()}</div>${mobileCartBar()}`;
  }
  function quickOrderTable(list, store) {
    if (!list.length) return emptyState('没有匹配的商品', '请换一个关键词或分类。', 'search');
    const groups = [...new Set(list.map(p => p.category))];
    return `<section class="section-card quick-order-table" tabindex="0"><div class="table-scroll-hint">↔ 左右滑动查看全部列</div><table><colgroup><col style="width:5%"><col style="width:35%"><col style="width:14%"><col style="width:12%"><col style="width:20%"><col style="width:14%"></colgroup><thead><tr><th>No.</th><th>品名 / 包装规格</th><th>订货单位</th><th>单价</th><th>订购数量</th><th>金额</th></tr></thead><tbody>${groups.map(c => `<tr class="quick-category-row"><th colspan="6">${esc(c)} <span>${list.filter(p => p.category === c).length} 项</span></th></tr>${list.filter(p => p.category === c).map((p, i) => {
      const q = quote(p, store.id), qty = model.state.cart[p.id] || 0;
      return `<tr><td class="muted-copy">${String(i + 1).padStart(2, '0')}</td><td><div class="quick-product">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : `<span class="quick-product-symbol">${icon('box')}</span>`}<div>${productName(p, 'quick-name')}<span class="quick-spec">${esc(p.spec)}</span></div></div></td><td class="quick-unit">${unitSelector(p)}</td><td class="quick-price">${q.price === null ? '<span class="quote-unavailable">待报价</span>' : `<strong>${money(q.price)}</strong><span class="tax-label">${taxLabel(q)}</span>`}</td><td>${q.price === null ? '<button class="text-button" data-action="price-info" data-id="' + p.id + '">查看待确认项</button>' : qtyControl(p.id, qty, model.getUnitOrderableStock(store.id,p.id,model.getCartUnit(p.id)))}</td><td class="quick-amount" data-line-amount="${p.id}">${qty > 0 ? amount(p, qty, store.id) : '—'}</td></tr>`;
    }).join('')}`).join('')}</tbody></table></section>`;
  }
  function productCards(list, store) {
    const visible = list.slice().sort((a, b) => Number(quote(a, store.id).price === null) - Number(quote(b, store.id).price === null)).slice(0, ui.productLimit || 24);
    return `<div class="product-grid">${visible.map(p => {
      const q = store ? quote(p, store.id) : { kind: '尚待报价' };
      return `<article class="product-card"><div class="product-art ${p.image ? 'product-photo' : 'art-cream'}">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : `<span class="product-emoji">${icon('box')}</span>`}<span class="product-category">${esc(p.category)}</span></div><div class="product-card-content">${productName(p, 'product-name')}<p class="product-spec">${esc(p.spec)} </p>${unitSelector(p)}<span class="tax-label">${taxLabel(q)}</span><div class="product-bottom"><div class="price">${money(q.price)}<small>${q.price === null ? '' : '/ ' + esc(model.getCartUnit(p.id))}</small></div>${q.price === null ? '' : qtyControl(p.id, model.state.cart[p.id] || 0, model.getUnitOrderableStock(store.id,p.id,model.getCartUnit(p.id)))}</div></div></article>`;
    }).join('')}</div>${visible.length < list.length ? `<div class="show-more">${button('加载更多商品（' + visible.length + ' / ' + list.length + '）', 'more-products', 'secondary')}</div>` : ''}`;
  }
  function inventoryDisplay(p, value, kind, storeId) {
    const equivalents = kind === 'warehouse' && value !== null ? model.getSaleUnits(p.id).filter(u => u.unit !== p.unit).map(u => `<span class="inventory-equivalent">${stockQuantityText(model.getWarehouseUnitStock(p.id, u.unit), esc(u.unit))}</span>`).join(' / ') : '';
    return `<div class="inventory-display"><div class="inventory-stock-line"><span class="inventory-primary">${kind==='warehouse'&&model.isStockUnlimited(p.id)?'无限':value === null ? (kind === 'warehouse' ? '未盘点' : '共享余量') : stockQuantityText(value, esc(p.unit))}</span><button class="cell-edit-button edit-icon-button" data-action="edit-inventory-cell" data-id="${p.id}" data-kind="${kind}" data-store="${storeId}" aria-label="编辑${esc(p.name)}${kind === 'warehouse' ? '总库存' : '门店额度'}">${icon('edit')}</button></div>${equivalents ? `<span class="inventory-equivalents">${equivalents}</span>` : ''}</div>`;
  }
  function saleUnitsDisplay(p) {
    const units = model.getSaleUnits(p.id);
    const equations = model.getSaleUnitEquations(p.id).filter(e => e.fromUnit !== e.toUnit);
    return `<div class="sale-units-display"><div class="sale-units-main"><div class="sale-unit-tags">${units.map(u => `<span class="catalogue-unit-pill">${esc(u.unit)}</span>`).join('')}</div><button class="cell-edit-button edit-icon-button" data-action="edit-sale-units" data-id="${p.id}" aria-label="编辑${esc(p.name)}可售卖单位">${icon('edit')}</button></div><div class="cell-edit-hint">${equations.map(e => `<span class="unit-equation-summary">${formatUnitQuantity(e.fromQty)} ${esc(e.fromUnit)} = ${formatUnitQuantity(e.toQty)} ${esc(e.toUnit)}</span>`).join('；') || '库存按' + esc(p.unit) + '记录'}</div></div>`;
  }
  function formatUnitQuantity(value) {
    return String(Math.round(Number(value) * 1000000) / 1000000);
  }
  function stockQuantityText(value, unit) {
    const rounded = formatUnitQuantity(value);
    const approximate = Math.abs(Number(value) - Number(rounded)) > Math.max(1e-10, Math.abs(Number(value)) * Number.EPSILON * 8);
    return (approximate ? '≈ ' : '') + rounded + ' ' + unit;
  }
  function unitRow(p, row = {fromQty:1,fromUnit:p.unit,toQty:'',toUnit:''}) {
    const side = (key, label) => `<div class="unit-equation-side"><input class="input" data-unit-${key}-qty type="number" min="0.000001" max="1000000" step="0.000001" value="${esc(row[key + 'Qty'])}" aria-label="${label}数量" placeholder="数量" required><select class="input" data-unit-${key}-name aria-label="${label}单位" required><option value="" disabled ${SALE_UNIT_OPTIONS.includes(row[key + 'Unit']) ? '' : 'selected'}>${row[key + 'Unit'] && !SALE_UNIT_OPTIONS.includes(row[key + 'Unit']) ? '原：' + esc(row[key + 'Unit']) : '单位'}</option>${SALE_UNIT_OPTIONS.map(unit => `<option value="${unit}" ${row[key + 'Unit'] === unit ? 'selected' : ''}>${unit}</option>`).join('')}</select></div>`;
    return `<div class="sale-unit-row unit-equation-row">${side('from','左侧')}<span class="unit-equation-equals" aria-hidden="true">=</span>${side('to','右侧')}<button class="cell-edit-button" type="button" data-action="remove-sale-unit" aria-label="移除此换算关系">移除</button></div>`;
  }
  function inventoryUnitOptions(p, kind) {
    const units = model.getSaleUnits(p.id).map(u => u.unit);
    return kind === 'warehouse' ? [...new Set([p.unit, ...units])] : units;
  }
  function inventoryInputStep(p, kind, unit) {
    return unit === 'KG' ? '0.001' : '1';
  }
  function inventoryEntryBase(form) {
    if (form.dataset.lastQuantity === form.elements.quantity.value && form.dataset.quantityBase !== undefined) return Number(form.dataset.quantityBase);
    const unit = form.elements.inventoryUnit?.value || form.elements.allocationUnit.value;
    return Number(form.elements.quantity.value) / model.getUnitFactor(form.dataset.product, unit);
  }
  function updateInventoryHint(form) {
    const hint = form.querySelector('[data-inventory-conversion]');
    if (!hint) return;
    const p = model.getProduct(form.dataset.product), field = form.elements.quantity;
    const unit = form.elements.inventoryUnit?.value || form.elements.allocationUnit?.value || p.unit;
    if (field.value === '') {
      hint.textContent = form.dataset.inlineKind === 'warehouse' ? '留空表示未盘点。' : '留空使用共享余量。';
      return;
    }
    const value = Number(field.value);
    if (!Number.isFinite(value) || value < 0) { hint.textContent = ''; return; }
    const base = inventoryEntryBase(form);
    const others = inventoryUnitOptions(p, form.dataset.inlineKind).filter(u => u !== unit).map(u => stockQuantityText(base * model.getUnitFactor(p.id, u), u));
    hint.textContent = others.length ? '相当于 ' + others.join(' / ') : '';
  }
  function handleInlineChange(input) {
    const unitsForm = input.closest('#sale-units-form');
    if (unitsForm) {
      unitsForm.querySelector('#sale-unit-error').textContent = '';
      return true;
    }
    const form = input.closest('.inventory-editor');
    if (!form || !['quantity','inventoryUnit','allocationUnit','unlimited'].includes(input.name)) return false;
    if(input.name==='unlimited'){form.elements.quantity.disabled=input.checked;form.elements.inventoryUnit.disabled=input.checked;form.querySelector('[data-inventory-conversion]').textContent=input.checked?'不受库存数量限制。':'填写盘点总量；留空为未盘点。';return true;}
    if (input.name !== 'quantity' && form.dataset.entryUnit !== input.value) {
      const field = form.elements.quantity, p = model.getProduct(form.dataset.product);
      if (field.value !== '' && Number.isFinite(Number(field.value))) {
        const base = form.dataset.lastQuantity === field.value && form.dataset.quantityBase !== undefined ? Number(form.dataset.quantityBase) : Number(field.value) / model.getUnitFactor(p.id, form.dataset.entryUnit);
        field.value = formatUnitQuantity(base * model.getUnitFactor(p.id, input.value));
        form.dataset.quantityBase = String(base);
        form.dataset.lastQuantity = field.value;
      }
      field.step = inventoryInputStep(p, form.dataset.inlineKind, input.value);
      form.dataset.entryUnit = input.value;
    } else if (input.name === 'quantity') {
      form.dataset.quantityBase = String(Number(input.value) / model.getUnitFactor(form.dataset.product, form.dataset.entryUnit));
      form.dataset.lastQuantity = input.value;
    }
    updateInventoryHint(form);
    return true;
  }
  function cataloguePage() {
    if (ui.page === 'catalogue' && ui.catalogueTrash) return recycleBinPage();
    const store = model.getStores().find(store => store.id === ui.quoteStore) || model.getStores()[0], list = filtered(), warehouse = ui.catalogueLayer !== 'store';
    if (!store && !warehouse) return ctx.managementHeading('stores', 'quotes', button('新建门店', 'add-store', 'primary')) + emptyState('暂无门店', '', 'store');
    const qty = (n, unit) => n === null ? '未盘点' : stockQuantityText(n, esc(unit));
    const valueCell = (n, unit) => `<span class="catalogue-number">${qty(n, unit)}</span>`;
    const input = (p, n, kind) => inventoryDisplay(p, n, kind, store?.id || '');
    return ctx.managementHeading(warehouse ? 'products' : 'stores', warehouse ? 'inventory' : 'quotes', warehouse ? button('回收站 <span class="counter">' + model.getDeletedProducts().length + '</span>', 'recycle-bin', 'secondary', '', 'trash') : '') + `
    <section class="section-card catalogue-card"><div class="catalogue-context"><div class="catalogue-context-copy">${warehouse ? `<strong>${esc(company.name)} · 总库存</strong>` : `<div class="store-quote-selectors"><div class="field"><label class="small-label" for="quote-store">选择门店</label><select class="select quote-select" id="quote-store">${model.getStores().map(s => `<option value="${s.id}" ${s.id === store.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div><div class="field"><label class="small-label" for="store-quote-plan">报价方案</label>${ctx.pricingSelector?.(store)||''}</div></div>`}</div>${warehouse ? `<div class="catalogue-actions" aria-label="公司商品管理">${button('导入供货目录', 'import-products', 'secondary', '', 'download')}${button('新增商品', 'add-product', 'primary', '', 'plus')}</div>` : ''}</div><div class="catalogue-filterbar">${chips()}<label class="search-box catalogue-search">${icon('search')}<input id="catalogue-search" placeholder="搜索商品名称、规格" aria-label="搜索商品报价" value="${esc(ui.query)}"></label></div><div class="table-scroll" tabindex="0"><div class="table-scroll-hint">↔ 左右滑动查看全部列</div><table class="catalog-table ${warehouse ? 'warehouse-table' : 'store-quote-table'}">${warehouse ? `<colgroup><col class="catalogue-col-product"><col class="catalogue-col-cost"><col class="catalogue-col-units"><col class="catalogue-col-stock"><col class="catalogue-col-metric"><col class="catalogue-col-metric"><col class="catalogue-col-metric"><col class="catalogue-col-action"></colgroup>` : ''}<thead><tr><th>商品 / 规格</th>${warehouse ? '<th>成本价</th><th>可售卖单位</th><th>公司总库存</th><th>订单占用</th><th>门店已分配</th><th>共享余量</th>' + '<th class="catalogue-actions-col">操作</th>' : '<th>公司可用库存</th><th>本店可订额度</th><th>本店单价 / 税口径</th>'}</tr></thead><tbody>${list.map(p => {
      const cost=productCost(p);
      const available = model.getStock(p.id), allocated = model.getAllocatedQty(p.id), q = store ? quote(p, store.id) : { kind: '尚待报价' };
      return `<tr data-catalogue-row="${p.id}"><td><div class="product-table-cell">${p.image ? `<img class="catalogue-photo" src="${esc(p.image)}" alt="" loading="lazy">` : `<div class="product-table-art">${icon('box')}</div>`}<div><div class="catalogue-product-heading">${productName(p)}</div><div class="catalogue-product-meta"><span class="cell-secondary">${esc(p.spec)}</span></div></div></div></td>${warehouse ? `<td><div class="catalogue-cost-cell"><span>${cost.price==null?'未设置':money(cost.price)}</span><button type="button" class="cell-edit-button edit-icon-button" data-action="product-cost" data-id="${p.id}" aria-label="编辑${esc(p.name)}成本价">${icon('edit')}</button></div><span class="cell-edit-hint">日元 / ${esc(p.unit)}${cost.source?'<br>'+esc(cost.source):''}</span></td><td data-sale-units>${saleUnitsDisplay(p)}</td><td>${input(p, model.getWarehouseStock(p.id), 'warehouse')}</td><td data-reserved>${valueCell(model.getReservedQty(p.id), p.unit)}</td><td data-allocated>${valueCell(allocated, p.unit)}</td><td data-shared>${model.isStockUnlimited(p.id)?'<span class="catalogue-number">无限</span>':valueCell(available === null ? null : available - allocated,p.unit)}</td><td class="catalogue-actions-col"><button class="row-action row-action-danger product-delete-button" data-action="delete-product" data-id="${p.id}" aria-label="删除${esc(p.name)}">${icon('trash')}删除</button></td>` : `<td>${model.isStockUnlimited(p.id)?'<span class="catalogue-number">无限</span>':valueCell(available,p.unit)}<span class="cell-edit-hint">已扣除订单占用</span></td><td>${input(p, model.getAllocation(store.id,p.id), 'allocation')}<div class="allocation-unit-equivalents">${model.isStockUnlimited(p.id)&&model.getOrderableStock(store.id,p.id)===null?'':model.getSaleUnits(p.id).map(u => { const n = model.getUnitOrderableStock(store.id,p.id,u.unit); return `<span>${n === null ? (model.isStockUnlimited(p.id)?'无限':"待确认 " + esc(u.unit)) : stockQuantityText(n,esc(u.unit))}</span>`; }).join(" / ")}</div><span class="cell-edit-hint" data-orderable>库存额度：${model.isStockUnlimited(p.id)&&model.getOrderableStock(store.id,p.id)===null?'无限':qty(model.getOrderableStock(store.id,p.id),p.unit)}</span></td><td>${unitQuoteEditor(p,store)}</td>`}</tr>`;
    }).join('')}</tbody></table></div>${list.length ? '' : emptyState('没有匹配的商品','请更换关键词或分类。','search')}</section><div class="catalogue-layer-note">${icon('help')} ${warehouse ? '填写盘点后的总量。未送达订单占用仍计入总库存，确认送达后扣除；未盘点时留空。' : '门店额度各自独立，下单同步扣减公司可用库存与本店额度。报价只影响新订单。'}</div>`;
  }
  function recycleBinPage() {
    const deleted = model.getDeletedProducts();
    const query = (ui.recycleQuery || '').trim().toLocaleLowerCase();
    const list = deleted.filter(p => [p.name, p.spec, p.category, p.unit].join(' ').toLocaleLowerCase().includes(query));
    const deletedTime = value => new Date(value).toLocaleString('zh-CN', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    return titleHeading('商品回收站', '恢复后，商品的图片、单位、库存和门店报价会一并保留。', button('返回商品列表', 'recycle-back', 'secondary', '', 'arrow')) +
      `<section class="section-card recycle-card"><div class="recycle-toolbar"><div><h2 class="section-title">已删除商品 <span class="counter">${deleted.length}</span></h2></div><label class="search-box recycle-search">${icon('search')}<input id="recycle-search" value="${esc(ui.recycleQuery || '')}" placeholder="搜索已删除商品" aria-label="搜索回收站商品"></label></div>${list.length ? `<ul class="recycle-list">${list.map(p => `<li class="recycle-item" data-recycle-id="${p.id}"><div class="product-table-cell recycle-product">${p.image ? `<img class="catalogue-photo" src="${esc(p.image)}" alt="" loading="lazy">` : `<div class="product-table-art">${icon('box')}</div>`}<div>${productName(p)}<div class="cell-secondary">${esc(p.spec || '规格未填写')}</div><div class="cell-secondary">${esc(p.category)} · ${model.getSaleUnits(p.id).map(u => esc(u.unit)).join(' / ')}</div></div></div><div class="recycle-date"><span>删除时间（东京）</span><time datetime="${esc(p.deletedAt)}">${esc(deletedTime(p.deletedAt))}</time></div>${button('恢复', 'restore-product', 'secondary', `data-id="${p.id}" aria-label="恢复${esc(p.name)}"`, 'refresh')}</li>`).join('')}</ul>` : emptyState(deleted.length ? '没有匹配的已删除商品' : '回收站为空', deleted.length ? '请更换商品名称或规格搜索。' : '删除的商品会保留在这里，可随时恢复。', deleted.length ? 'search' : 'trash')}</section>`;
  }
  async function handleInlineSubmit(form) {
    if (form.dataset.saving) return;
    form.dataset.saving = 'true';
    const submit = form.querySelector('[type=submit]'); if (submit) submit.disabled = true;
    const feedback = form.querySelector('.inline-editor-feedback');
    try {
      if (ui.role !== 'admin') throw new Error('仅管理员可修改库存与报价。');
      const id = form.dataset.product, storeId = form.dataset.store, v = Object.fromEntries(new FormData(form));
      if (form.dataset.inlineKind === 'warehouse') {if(v.unlimited==='on')await model.enableUnlimitedStock(id);else await model.setWarehouseUnitStock(id,v.inventoryUnit || model.getProduct(id).unit,v.quantity);}
      if (form.dataset.inlineKind === 'allocation') await model.setStoreUnitAllocation(storeId,id,v.allocationUnit || model.getProduct(id).unit,v.quantity);
      if (form.dataset.inlineKind === 'quote') {
        await model.setUnitQuote(storeId,id,v.quoteUnit || form.dataset.saleUnit || model.getProduct(id).unit,v.price,v.taxBasis,v.taxBasis === 'unspecified' || !v.taxRate ? null : Number(v.taxRate)/100);
      }
      const p = model.getProduct(id), row = form.closest('tr'), stock = model.getStock(id), allocated = model.getAllocatedQty(id);
      const show = n => n === null ? (model.isStockUnlimited(id)?'无限':'待确认') : stockQuantityText(n, p.unit);
      for (const [selector,n] of [['[data-reserved]',model.getReservedQty(id)],['[data-allocated]',allocated],['[data-shared]',stock === null ? null : stock - allocated]]) {
        const el = row.querySelector(selector); if (el) (el.querySelector('.catalogue-number') || el).textContent = show(n);
      }
      const el = row.querySelector('[data-orderable]'); if (el) el.textContent = '库存额度：' + show(model.getOrderableStock(storeId,id));
      const equivalents = row.querySelector('.allocation-unit-equivalents');
      if (equivalents) equivalents.textContent = model.isStockUnlimited(id)&&model.getOrderableStock(storeId,id)===null?'':model.getSaleUnits(id).map(u => { const n=model.getUnitOrderableStock(storeId,id,u.unit); return n === null ? '待确认 ' + u.unit : stockQuantityText(n,u.unit); }).join(' / ');
      if (form.dataset.inlineKind !== 'quote') {
        form.outerHTML = inventoryDisplay(p, form.dataset.inlineKind === 'warehouse' ? model.getWarehouseStock(id) : model.getAllocation(storeId,id), form.dataset.inlineKind, storeId);
      } else { form.closest('.store-unit-quotes').outerHTML = unitQuoteEditor(p,model.getStore(storeId)); }
    } catch (error) { feedback.textContent = error.message; feedback.className = 'inline-editor-feedback error'; }
    finally { delete form.dataset.saving; if (submit) submit.disabled = false; }
  }
  async function handleUnitsSubmit(form) {
    if (form.dataset.saving) return;
    form.dataset.saving = 'true';
    const submit = form.querySelector('[type=submit]'), originalText = submit?.textContent;
    if (submit) { submit.disabled = true; submit.textContent = '保存中…'; }
    try {
      if (ui.role !== 'admin') throw new Error('仅管理员可修改。');
      const rows = [...form.querySelectorAll('.unit-equation-row')].map(row => ({fromQty:row.querySelector('[data-unit-from-qty]').value,fromUnit:row.querySelector('[data-unit-from-name]').value,toQty:row.querySelector('[data-unit-to-qty]').value,toUnit:row.querySelector('[data-unit-to-name]').value}));
      await model.setSaleUnitEquations(form.elements.productId.value, rows);
      ctx.closeOverlay(); ctx.render();
    } catch (error) { const el = form.querySelector('#sale-unit-error'); el.textContent = error.message; el.className = 'inline-editor-feedback error'; }
    finally { delete form.dataset.saving; if (submit) { submit.disabled = false; submit.textContent = originalText; } }
  }
  function preciseCost(value) { return value === null || value === undefined ? '待确认' : '¥' + new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 6 }).format(value); }
  function costsPage() {
    const attachment = ui.costSource === 'attachment';
    const list = (attachment ? procurementAttachment : materialCosts).filter(r => (r.name + r.spec).toLowerCase().includes(ui.query.toLowerCase()));
    const conflictCount = materialSummary.costConflicts.length;
    return ctx.managementHeading('products', 'costs', sourceLink(attachment ? 'materials/附件一：产品清单.pdf' : 'materials/每度商事产品成本价格表.xlsx', '打开原始成本资料')) +
      `<div class="cost-summary-grid">${ctx.statCard('成本表商品', materialCosts.length, '产品底价表 · 原始精度保留', 'box')}${ctx.statCard('采购清单商品', procurementAttachment.length, '采购未税与含税列分开展示', 'clipboard')}${ctx.statCard('成本差异待核对', conflictCount, '主表与来源记录不一致', 'alert', 'orange')}</div><section class="section-card"><div class="filter-bar"><div class="tabs"><button class="tab ${!attachment ? 'active' : ''}" data-action="cost-source" data-source="workbook">产品成本表 <span>${materialCosts.length}</span></button><button class="tab ${attachment ? 'active' : ''}" data-action="cost-source" data-source="attachment">附件采购清单 <span>${procurementAttachment.length}</span></button></div><label class="search-box">${icon('search')}<input id="cost-search" value="${esc(ui.query)}" aria-label="搜索采购成本" placeholder="搜索品名或规格"></label></div><div class="cost-table"><table><thead><tr><th>商品 / 规格</th><th>计价单位</th><th>采购未税参考</th><th>${attachment ? '采购含税 / 税率' : '来源表原值'}</th><th>出处</th><th>核对状态</th></tr></thead><tbody>${list.map(r => {
      const conflict = !attachment && (r.flags || []).includes('primary-vs-provenance-cost-conflict');
      const price = attachment ? r.netPrice : r.costPrice;
      const costRange = !attachment && r.costRange ? `${preciseCost(r.costRange.min ?? r.costRange[0])}–${preciseCost(r.costRange.max ?? r.costRange[1])}` : preciseCost(price);
      return `<tr><td><strong>${esc(r.name)}</strong><div class="cell-secondary">${esc(r.spec)}</div></td><td>${esc(r.unit)}</td><td>${costRange}${!attachment && r.taxBasis !== 'exclusive' ? '<div class="review-label">税口径待核</div>' : ''}</td><td>${attachment ? preciseCost(r.grossPrice) + '<span class="tax-label">' + r.taxRate * 100 + '%</span>' : preciseCost(r.provenance?.sourceCostValue)}</td><td><span class="source-chip">${attachment ? '采购清单 · ' + r.serial : '产品底价表 · 第 ' + r.row + ' 行'}</span></td><td>${conflict ? '<span class="conflict-badge">主表与来源价格不同</span>' : !attachment && (r.costPrice === null || r.taxBasis !== 'exclusive') ? '<span class="review-label">需要核对</span>' : '<span class="source-label">参考记录</span>'}</td></tr>`;
    }).join('')}</tbody></table></div></section><div class="notice notice-warning">${icon('alert')} ${esc(materialSummary.costConflicts.join('、'))}存在主表与来源价格差异，请确认有效成本。KG 成本不等于一箱成本；未填写的库存保持未盘点。</div>`;
  }
  function documentsPage(client = false) {
    const docs = model.state.documents.filter(d => !client || d.storeId === activeStore().id);
    return titleHeading(client ? '我的月结与单据' : '单据与月结对账', '保留原单据金额、税额与运费，历史单据与当前订单分开展示。', client ? clientStoreSelect() : button('核对资料来源', 'view-materials', 'secondary', '', 'clipboard'), 'DELIVERY NOTES & STATEMENTS') +
      `<div class="document-grid">${docs.map(d => `<article class="document-card section-card"><div class="document-type">${icon(d.type === 'customer_outbound_delivery_note' ? 'truck' : 'wallet')}${esc(d.title)}<span class="source-label">原始单据</span></div><h2 class="document-title">${esc(d.customer)}</h2><p class="cell-secondary">${d.period ? d.period + ' 月结' : d.date + ' 出库纳品书'}${d.number ? ' · ' + esc(d.number) : ''}</p><div class="document-meta"><div><span>开票日期</span><strong>${d.date}</strong></div><div><span>${d.dueDate ? '付款期限' : '交付状态'}</span><strong>${d.dueDate || '原件未提供签收记录'}</strong></div><div><span>运费</span><strong>${d.shipping === null ? '原件未单列' : money(d.shipping)}</strong></div><div><span>付款状态</span><strong>待确认</strong></div></div><div class="document-amount"><span>原单据合计</span><strong>${money(d.totals.total)}</strong></div><div class="document-card-footer">${button('查看明细与对账', 'document-detail', 'primary', `data-id="${d.id}"`, 'arrow')}${sourceLink(d.source, '打开原件')}</div></article>`).join('') || emptyState('这家门店暂无导入单据', '管理员导入该门店的单据后，将在这里显示。', 'clipboard')}</div><div class="notice">${icon('help')} 月结单中的运费单独列示，食品与饮品保留原税额。当前不推断已付款、已签收或逾期。</div>`;
  }
  function openDocument(id) {
    const d = model.state.documents.find(d => d.id === id);
    if (!d || (ui.role !== 'admin' && d.storeId !== activeStore().id)) throw new Error('只能查看当前门店的单据。');
    const monthly = d.type !== 'customer_outbound_delivery_note';
    const table = monthly ? `<thead><tr><th>日期</th><th>项目</th><th>税前金额</th><th>原税额</th><th>原含税金额</th></tr></thead><tbody>${d.lines.map(l => `<tr><td>${l.transactionDate || d.period}</td><td>${esc(l.descriptionRaw)}</td><td>${money(l.net)}</td><td>${money(l.tax)}</td><td>${money(l.total)}</td></tr>`).join('')}</tbody>` :
      `<thead><tr><th>商品 / 规格</th><th>数量 / 单位</th><th>原单价</th><th>原税前金额</th></tr></thead><tbody>${d.lines.map(l => `<tr><td>${esc(l.productName)}<div class="cell-secondary">${esc(l.specRaw)}</div></td><td>${l.qty} ${esc(l.unitRaw)}</td><td>${money(l.price)}</td><td>${money(l.net)}</td></tr>`).join('')}</tbody>`;
    modal(d.customer + ' · ' + d.title, `<div class="document-detail"><div class="document-facts"><div><span>开票方</span><strong>${esc(d.issuer)}</strong></div><div><span>单据日期</span><strong>${d.date}</strong></div>${d.period ? `<div><span>账期</span><strong>${d.period}</strong></div><div><span>付款期限</span><strong>${d.dueDate}</strong></div>` : ''}</div><div class="document-totals"><div><span>原小计</span><strong>${money(d.totals.net)}</strong></div><div><span>原税额</span><strong>${money(d.totals.tax)}</strong></div><div><span>原合计</span><strong>${money(d.totals.total)}</strong></div></div><div class="doc-reconcile">${icon('check')} ${d.lines.length} 行原始记录 · 金额与税额按原单据保留。</div><div class="document-lines"><table>${table}</table></div><div class="notice notice-warning">${icon('alert')} ${monthly ? '运费与货品金额分别保留。税额按原单据各行记录，请结合原件核对取整差异。' : '单据保留原始明细和打印合计。存在取整差异时，请以原件核对结果为准。客户出库单据独立于采购成本。'}</div></div>`, button('关闭', 'close', 'secondary') + sourceLink(d.source, '打开原始 PDF'));
  }
  function materialsPage() {
    return titleHeading('资料与业务规则', '商品、订货单位、销售报价、采购成本和历史单据，分别核对并保留来源。', '', 'MATERIALS & BUSINESS RULES') +
      `<div class="source-summary-grid"><article class="source-summary-card"><span>${icon('clipboard')}</span><h3>123 行原订货表结构</h3><p>保留冷冻、常温、蔬菜、饮品、干调和代买品。重复商品合并目录，原订货单位保留。</p></article><article class="source-summary-card"><span>${icon('tag')}</span><h3>72 条销售报价</h3><p>真实商品照片与报价已导入。未知税口径保留待确认，包装明确时展示箱价换算依据。</p></article><article class="source-summary-card"><span>${icon('wallet')}</span><h3>采购与销售分开</h3><p>86 条成本表记录与 85 条采购清单记录独立展示。成本仅管理端可见。</p></article></div><section class="section-card"><div class="section-header"><h2 class="section-title">需要保留的业务规则</h2></div><div class="source-rule-list">${materialSummary.rules.map((r, i) => `<div class="source-rule"><span>${String(i + 1).padStart(2, '0')}</span><p>${esc(r)}</p></div>`).join('')}<div class="source-rule"><span>06</span><p>原表中的牛肉卷与报价单中的牛肉片保留为不同名称，未擅自合并报价；规格不足或单位有疑问的项目先待报价。</p></div></div></section><section class="section-card"><div class="section-header"><h2 class="section-title">原始业务资料</h2><span class="source-label">6 份文件均保留</span></div><div class="source-file-list">${materialSummary.sourceFiles.map(f => `<div class="source-file-row">${icon(f.name.endsWith('.jpg') ? 'grid' : 'clipboard')}<div><strong>${esc(f.name)}</strong><span>${f.name.endsWith('.xlsx') ? '采购参考成本' : f.name.includes('报价') ? '客户销售报价 · 税口径未注明' : f.name.includes('请求书') ? '历史月结单 · 运费独立' : f.name.includes('纳品书') ? '客户出库纳品书' : f.name.endsWith('.jpg') ? '神户元町 · 2026/10/7 订货样例' : '采购清单 · 未税与含税分列'}</span></div>${isCloud ? '<span class="source-label">已归档</span>' : `<a class="btn btn-secondary" href="${encodeURI(f.url)}" target="_blank" rel="noopener">打开原件 ${icon('arrow')}</a>`}</div>`).join('')}</div></section>`;
  }
  async function handleAction(action, el) {
    if (['recycle-bin', 'recycle-back', 'delete-product', 'confirm-delete-product', 'restore-product'].includes(action)) {
      if (ui.role !== 'admin') throw new Error('仅管理员可删除或恢复商品。');
      if (action === 'recycle-bin') {
        ui.catalogueTrash = true; ui.recycleQuery = ''; ui.mobile = false;
        history.replaceState(null, '', '?page=catalogue&recycle=1');
        ctx.render(); window.scrollTo({ top: 0 }); return true;
      }
      if (action === 'recycle-back') {
        ui.catalogueLayer = 'warehouse'; ctx.nav('catalogue'); return true;
      }
      const p = model.getProduct(el.dataset.id);
      if (!p) throw new Error('商品不存在。');
      if (action === 'delete-product') {
        if (p.deletedAt) throw new Error('商品已在回收站中。');
        const pendingOrders = model.state.orders.filter(o => o.stage !== 'delivered' && o.items.some(item => item.productId === p.id)).length;
        modal('删除商品', `<div class="recycle-confirm-product"><strong>${esc(p.name)}</strong><span>${esc(p.spec || '规格未填写')} · ${esc(p.unit)}</span></div><p class="modal-intro">删除后移入回收站，并从商品列表和门店订货页隐藏。可随时恢复，原有报价、库存和历史订单会保留。</p>${pendingOrders ? `<div class="notice">${icon('clipboard')} 该商品涉及 ${pendingOrders} 笔未完成订单，仍可继续配货和配送。</div>` : ''}`, button('取消', 'close', 'secondary') + button('移入回收站', 'confirm-delete-product', 'danger', `data-id="${p.id}"`, 'trash'));
        return true;
      }
      if (action === 'confirm-delete-product') {
        await model.deleteProduct(p.id);
        ctx.closeOverlay(); ctx.render(); ctx.toast(`「${p.name}」已移入回收站。`);
        return true;
      }
      await model.restoreProduct(p.id);
      ctx.render(); ctx.toast(`已恢复「${p.name}」。`);
      return true;
    }
    if (['add-unit-quote','edit-unit-quote','cancel-unit-quote'].includes(action)) {
      if (ui.role !== 'admin') throw new Error('仅管理员可编辑报价。');
      if (action === 'cancel-unit-quote') el.closest('.store-unit-quotes').outerHTML = unitQuoteEditor(model.getProduct(el.dataset.id),model.getStore(el.dataset.store));
      else openUnitQuoteForm(el,action === 'edit-unit-quote');
      return true;
    }

    if (['edit-inventory-cell','cancel-inventory-cell','edit-sale-units','add-sale-unit','remove-sale-unit'].includes(action) && ui.role !== 'admin') throw new Error('仅管理员可编辑。');
    if (action === 'edit-inventory-cell') {
      const p = model.getProduct(el.dataset.id), kind = el.dataset.kind, storeId = el.dataset.store;
      const base = kind === 'warehouse' ? model.getWarehouseStock(p.id) : model.getAllocation(storeId,p.id);
      const units = inventoryUnitOptions(p, kind);
      const stockInUnit = unit => base === null ? null : kind === 'warehouse' ? model.getWarehouseUnitStock(p.id,unit) : Math.round(base * model.getUnitFactor(p.id,unit) * 1000000)/1000000;
      const entryUnit = units.find(unit => { const n = stockInUnit(unit), precision = unit === 'KG' ? 1000 : 1; return n === null || Math.abs(n * precision - Math.round(n * precision)) < 0.000001; }) || units[0];
      const n = stockInUnit(entryUnit);
      const cell = el.closest('.inventory-display');
      cell.outerHTML = `<form class="inventory-editor" data-inline-kind="${kind}" data-product="${p.id}" data-store="${storeId}" data-entry-unit="${esc(entryUnit)}">${kind==='warehouse'?`<label class="inventory-unlimited-option"><input type="checkbox" name="unlimited" ${model.isStockUnlimited(p.id)?'checked':''}>无限</label>`:''}<div class="inventory-entry-fields"><input class="inline-number" name="quantity" type="number" min="0" step="${inventoryInputStep(p,kind,entryUnit)}" value="${n ?? ''}" placeholder="${kind === 'warehouse' ? '未盘点' : '共享余量'}" aria-label="${esc(p.name)}库存数量"><select class="sale-unit-select" name="${kind === 'warehouse' ? 'inventoryUnit' : 'allocationUnit'}" aria-label="${kind === 'warehouse' ? '盘点单位' : '额度单位'}">${inventoryUnitOptions(p,kind).map(unit => `<option value="${esc(unit)}" ${unit === entryUnit ? 'selected' : ''}>${esc(unit)}</option>`).join('')}</select></div><span class="inventory-conversion-hint" data-inventory-conversion></span><div class="inventory-entry-actions"><button class="catalogue-inline-submit" type="submit">保存</button><button class="cell-edit-button" type="button" data-action="cancel-inventory-cell">取消</button></div><span class="inline-editor-feedback" role="status"></span></form>`;
      const form = document.querySelector('[data-catalogue-row="' + p.id + '"] .inventory-editor');
      if (base !== null) { form.dataset.quantityBase = String(base); form.dataset.lastQuantity = form.elements.quantity.value; }
      updateInventoryHint(form);if(kind==='warehouse'&&model.isStockUnlimited(p.id)){form.elements.quantity.disabled=true;form.elements.inventoryUnit.disabled=true;form.querySelector('[data-inventory-conversion]').textContent='不受库存数量限制。';form.elements.unlimited.focus();}else form.elements.quantity.focus();
      return true;
    }
    if (action === 'cancel-inventory-cell') {
      const f = el.closest('form'), p = model.getProduct(f.dataset.product), kind = f.dataset.inlineKind, storeId = f.dataset.store;
      f.outerHTML = inventoryDisplay(p, kind === 'warehouse' ? model.getWarehouseStock(p.id) : model.getAllocation(storeId,p.id), kind, storeId); return true;
    }
    if (action === 'edit-sale-units') {
      const p = model.getProduct(el.dataset.id);
      const anchorHint = SALE_UNIT_OPTIONS.includes(p.unit) ? `至少一条关系包含 ${esc(p.unit)}，确保库存与报价联动。` : '商品原库存按重量记录，可使用 KG 配置换算关系。';
      modal('设置可售卖单位 · ' + esc(p.name), `<input type="hidden" name="productId" value="${p.id}"><div class="sale-unit-head unit-equation-head"><span>数量与单位</span><span></span><span>换算为</span><span></span></div><div id="sale-unit-rows">${model.getSaleUnitEquations(p.id).map(e => unitRow(p,e)).join('')}</div><button class="btn btn-secondary" type="button" data-action="add-sale-unit" data-id="${p.id}">${icon('plus')} 添加换算关系</button><p class="form-hint">例如 1 箱 = 15 KG，或 30 KG = 2 箱。多个关系可以连接，如 1 箱 = 3 袋、1 袋 = 5 KG。仅使用一种单位时，两侧选择相同单位、填写相同数量即可。</p><p class="form-hint">${anchorHint}</p><div class="inline-editor-feedback" id="sale-unit-error" role="alert"></div>`, button('取消','close','secondary') + '<button class="btn btn-primary" type="submit">保存单位</button>', 'sale-units-form'); return true;
    }
    if (action === 'add-sale-unit') {
      document.querySelector('#sale-unit-rows').insertAdjacentHTML('beforeend',unitRow(model.getProduct(el.dataset.id)));
      document.querySelector('#sale-unit-error').textContent = '';
      return true;
    }
    if (action === 'remove-sale-unit') {
      el.closest('.sale-unit-row').remove(); document.querySelector('#sale-unit-error').textContent = '';
      return true;
    }

    if (action === 'catalogue-layer') { if (ui.role !== 'admin') throw new Error('仅管理员可访问。'); ctx.nav(el.dataset.layer === 'store' ? 'stores' : 'catalogue', el.dataset.layer === 'store' ? 'quotes' : 'inventory'); return true; }
    if (action === 'product-view') { ui.productView = el.dataset.view; ctx.render(); return true; }
    if (action === 'more-products') { ui.productLimit = (ui.productLimit || 24) + 24; ctx.render(); return true; }
    if (action === 'price-info') { priceInfo(el.dataset.id); return true; }
    if (action === 'document-detail') { openDocument(el.dataset.id); return true; }
    if (action === 'cost-source') { if (ui.role !== 'admin') throw new Error('采购成本仅供管理员查看。'); ui.costSource = el.dataset.source; ui.query = ''; ctx.render(); return true; }
    if (action === 'view-materials') { ctx.nav('materials'); return true; }
    return false;
  }
  return { productCost, handleUnitsSubmit, handleInlineSubmit, handleInlineChange, sourceBanner, clientProductsPage, cataloguePage, costsPage, documentsPage, materialsPage, openDocument, handleAction };
}
