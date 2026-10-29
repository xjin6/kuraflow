import {
  materialProducts, materialStores, materialPrices, materialQuoteMeta,
  materialDocuments, exampleOrderLines, company, materialSummary,
} from './business-data.js';
import { isLegacyShortageNote, isPackingShortage, packingLineDone } from './notification-domain.js';
import { resolveUnitPrice } from './unit-pricing.js';

export const DEMO_DATE = '2026-10-08';
export const STORAGE_KEY = 'kuraflow-business-preview-v2';
export const categories = ['冷冻品', '常温品', '蔬菜品', '饮品', '干调类', '代买品', '其他食材'];
export const SALE_UNIT_OPTIONS = Object.freeze(['箱', '袋', '包', '瓶', '罐', '盒', '桶', '个', '500g', 'KG']);
export const products = materialProducts;
export const stores = materialStores;

const STAGES = ['pending', 'packing', 'ready', 'delivering', 'delivered'];
const TAX_BASES = ['unspecified', 'exclusive', 'inclusive'];
const clone = value => JSON.parse(JSON.stringify(value));
const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100;
const isBlank = value => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
function syncPackingIssues(order, item, done, now = new Date().toISOString()) {
  if (done && isPackingShortage(item)) {
    item.packingIssue = { type: 'shortage', reportedAt: item.packingIssue?.reportedAt || now,
      ...item.packingIssue, status: 'resolved', resolution: 'packed', updatedAt: now, resolvedAt: now };
  } else if (!done && item.packingIssue?.resolution === 'packed') {
    item.packingIssue = { ...item.packingIssue, status: 'open', updatedAt: now };
    delete item.packingIssue.resolvedAt; delete item.packingIssue.resolution;
  }
  if (order.issue && !order.issueResolvedAt && order.items.every(packingLineDone)) {
    order.issueResolvedAt = now; order.issueResolution = 'packed';
  } else if (!done && order.issueResolution === 'packed') {
    delete order.issueResolvedAt; delete order.issueResolution;
  }
}
export const isWeightUnit = unit => String(unit).trim().toUpperCase() === 'KG';
const roundQuantity = (value, unit) => {
  // Inventory conversions need more precision than editable quantities. A
  // counted 1 KG at 15 KG/箱 must remain a whole orderable KG after conversion.
  return Number(value.toPrecision(15));
};
const normalizedSaleUnit = value => /^(kg|千克|公斤)$/i.test(String(value || '').trim())
  ? 'KG' : String(value || '').trim();
const ratiosAgree = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b), 1e-12) * 1e-10;
const validateFixedWeightUnits = factors => {
  if (factors.has('KG') && factors.has('500g') && !ratiosAgree(factors.get('500g'), factors.get('KG') * 2)) {
    throw new Error('500g 与 KG 的换算须为 2 × 500g = 1 KG。');
  }
};
const intrinsicWeightKg = unit => {
  const match = /^(\d+(?:\.\d+)?)\s*(g|kg)$/i.exec(String(unit).trim());
  if (!match) return null;
  const weight = Number(match[1]) / (match[2].toLowerCase() === 'g' ? 1000 : 1);
  return weight > 0 && weight <= 1000000 ? weight : null;
};
const unitEquationDefaults = (product, units) => {
  const weight = intrinsicWeightKg(product.unit);
  if (!SALE_UNIT_OPTIONS.includes(product.unit) && weight !== null) {
    const configured = units.filter(row => row.unit !== product.unit);
    return configured.length ? configured.map(row => ({ fromQty: 1, fromUnit: 'KG', toQty: row.perBase / weight, toUnit: row.unit }))
      : [{ fromQty: 1, fromUnit: 'KG', toQty: 1, toUnit: 'KG' }];
  }
  return units.map(row => ({ fromQty: 1, fromUnit: product.unit, toQty: row.perBase, toUnit: row.unit }));
};

// These codes belong only to the browser prototype. Production authentication
// is handled by the server; this local lookup is not an authentication boundary.
export function normalizeStoreAccessCode(raw) {
  if (typeof raw !== 'string') return '';
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return /^(?=.*[A-Z])(?=.*[0-9])[A-Z0-9]{16}$/.test(code) ? code.match(/.{4}/g).join('-') : '';
}

function newStoreAccessCode(existing) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  if (!globalThis.crypto?.getRandomValues) throw new Error('当前浏览器不支持生成门店识别码，请使用较新的浏览器。');
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    while (code.length < 16) {
      for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(16))) {
        // Rejection sampling avoids giving the first characters extra weight.
        if (byte < 252 && code.length < 16) code += alphabet[byte % alphabet.length];
      }
    }
    const formatted = normalizeStoreAccessCode(code);
    if (formatted && !existing.has(formatted)) return formatted;
  }
  throw new Error('门店识别码生成失败，请重试。');
}

function localStoreCodes(state) {
  const seen = new Set();
  let changed = false;
  for (const store of state.stores) {
    if (store.deletedAt) continue;
    const previous = normalizeStoreAccessCode(store.accessCode);
    const code = previous && !seen.has(previous) ? previous : newStoreAccessCode(seen);
    if (store.accessCode !== code) { store.accessCode = code; changed = true; }
    seen.add(code);
  }
  return changed;
}

function storeDetails(value) {
  const text = (value, label, max = 120) => {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.trim().length > max) throw new Error(`${label}请填写有效文字，最多 ${max} 字。`);
    return value.trim();
  };
  const name = text(value.name, '门店名称');
  if (!name) throw new Error('请填写门店名称。');
  const location = {
    prefecture: text(value.prefecture, '都道府县'), municipality: text(value.municipality, '市区町村'),
    ward: text(value.ward, '区'), addressDetail: text(value.addressDetail, '详细地址', 500),
    prefectureCode: text(value.prefectureCode, '都道府县编号', 2),
    municipalityCode: text(value.municipalityCode, '市区町村编号', 5), wardCode: text(value.wardCode, '行政区编号', 5),
  };
  const image = value.image === '' || value.image == null ? null : value.image;
  if (image !== null && (typeof image !== 'string' || image.length > 1200000
    || !/^(?:data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+|\/api\/images\/[a-f0-9-]{36})$/.test(image))) {
    throw new Error('请上传有效的 PNG、JPEG 或 WebP 门店图片。');
  }
  return {
    name, ...location,
    city: text(value.city, '所在城市') || location.municipality || location.prefecture,
    address: text(value.address, '门店地址', 500) || [location.prefecture, location.municipality, location.ward, location.addressDetail].join(''),
    contact: text(value.contact, '联系人'), phone: text(value.phone, '联系电话', 80),
    account: text(value.account, '登录账号'), image,
  };
}

function hasPrecision(value, digits) {
  if (digits === 0) return Number.isSafeInteger(value);
  const factor = 10 ** digits;
  const scaled = value * factor;
  return Math.abs(scaled - Math.round(scaled)) <= Math.max(1, Math.abs(scaled)) * Number.EPSILON * 4;
}

function quantity(rawValue, unit, label = '数量', allowUnknown = false) {
  if (allowUnknown && isBlank(rawValue)) return null;
  const value = Number(rawValue);
  const digits = isWeightUnit(unit) ? 3 : 0;
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER / 1000 || !hasPrecision(value, digits)) {
    throw new Error(isWeightUnit(unit)
      ? `${label}须为非负数字，KG 商品最多保留三位小数。`
      : `${label}须为非负整数，请按完整计价单位填写。`);
  }
  return Math.round(value * 10 ** digits) / 10 ** digits;
}

function quotePrice(rawPrice, allowUnknown = false) {
  if (allowUnknown && isBlank(rawPrice)) return null;
  const value = Number(rawPrice);
  if (!Number.isFinite(value) || value <= 0 || value > Number.MAX_SAFE_INTEGER / 100 || !hasPrecision(value, 2)) {
    throw new Error('日元报价须大于 0，最多保留两位小数。');
  }
  return roundMoney(value);
}

function taxFields(taxBasis = 'unspecified', rawRate = null) {
  if (!TAX_BASES.includes(taxBasis)) throw new Error('税口径须为未注明、未税或含税。');
  const taxRate = isBlank(rawRate) ? null : Number(rawRate);
  if (taxRate !== null && (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1)) throw new Error('税率须在 0 至 1 之间。');
  if (taxBasis === 'unspecified' && taxRate !== null) throw new Error('未注明税口径时，请先确认税口径再填写税率。');
  return { taxBasis, taxRate };
}

export function money(value) {
  if (isBlank(value) || !Number.isFinite(Number(value))) return '待报价';
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency', currency: 'JPY', minimumFractionDigits: 0, maximumFractionDigits: 2,
  }).format(Number(value));
}
export const unitMoney = money;

export function formatDate(value, options = {}) {
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00+09:00`);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', ...options,
  }).format(date);
}

function snapshotLine(state, storeId, sourceLine) {
  const product = state.products.find(item => item.id === sourceLine.productId);
  const meta = state.quoteMeta[storeId]?.[sourceLine.productId] || {};
  const price = state.prices[storeId]?.[sourceLine.productId] ?? null;
  return {
    productId: sourceLine.productId, qty: sourceLine.qty, packedQty: 0, price,
    unit: product?.unit || '', taxBasis: meta.taxBasis || 'unspecified', taxRate: meta.taxRate ?? null,
    quoteSource: clone(meta.source ?? null), quoteKind: meta.kind || (price === null ? 'unquoted' : 'reference'),
  };
}

function seedState() {
  const state = {
    version: 2, products: clone(materialProducts), stores: clone(materialStores),
    prices: clone(materialPrices), quoteMeta: clone(materialQuoteMeta),
    inventory: Object.fromEntries(materialProducts.map(product => [product.id, product.stock ?? null])),
    storeAllocations: {}, unitQuotes: {}, cartUnits: {},
    orders: [], documents: clone(materialDocuments), materialSummary: clone(materialSummary),
    priceHistory: [], cart: {}, activeStoreId: materialStores[0]?.id || '', reminders: [], manualTasks: [],
    settings: {
      companyName: typeof company === 'string' ? company : company.name || company.companyName || '每度商事',
      cutoffTime: '22:00', deliveryWindow: '09:00–12:00', currency: 'JPY', language: 'zh-CN',
    },
  };
  const demoStore = state.stores.find(store => store.id === 's-kobe');
  if (demoStore && exampleOrderLines.length) {
    state.orders.push({
      id: 'DEMO-1008-01', storeId: demoStore.id, date: DEMO_DATE, deliveryDate: DEMO_DATE,
      submittedAt: `${DEMO_DATE}T00:00:00+09:00`, stage: 'pending', isDemo: true,
      sourceDate: '2026-10-07', source: 'materials/订货单案例.jpg', origin: 'screenshot_example',
      note: '按 10 月 7 日订货单样例建立的流程演示，数量来自原图；下单和配送状态为演示状态。',
      items: exampleOrderLines.map(line => snapshotLine(state, demoStore.id, line)),
    });
  }
  return state;
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function manualTaskDate(value) {
  if(typeof value!=='string'||!isDate(value)||value<'1000-01-01')throw new Error('请选择有效的截止日期。');
  return value;
}
function manualTaskDetails(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !['title', 'note', 'dueDate'].includes(key))) {
    throw new Error('待办内容格式不正确。');
  }
  const normalize = (input, label, max, required = false) => {
    if (input == null && !required) return '';
    if (typeof input !== 'string' || input.length > max) throw new Error(`${label}最多 ${max} 字。`);
    const text = input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
    if (required && !text) throw new Error(`请填写${label}。`);
    return text;
  };
  const dueDate = manualTaskDate(value.dueDate);
  return { title: normalize(value.title, '待办事项', 120, true).replace(/[\r\n\t]+/g, ' '),
    note: normalize(value.note, '备注', 500), dueDate };
}

export class KitchenModel {
  constructor() {
    this.localPreview = true;
    this.storage = null;
    try { this.storage = globalThis.localStorage || null; } catch { /* Storage may be disabled. */ }
    this.state = seedState();
    try {
      const saved = JSON.parse(this.storage?.getItem(STORAGE_KEY) || 'null');
      if (saved?.version === 2 && Array.isArray(saved.products) && Array.isArray(saved.stores) && Array.isArray(saved.orders) && saved.prices) {
        this.state = { ...this.state, ...saved };
        this.state.inventory = { ...Object.fromEntries(saved.products.map(product => [product.id, product.stock ?? null])), ...saved.inventory };
        this.state.storeAllocations = saved.storeAllocations && typeof saved.storeAllocations === 'object'
          && !Array.isArray(saved.storeAllocations) ? saved.storeAllocations : {};
        this.state.quoteMeta = saved.quoteMeta || clone(materialQuoteMeta);
        this.state.documents = Array.isArray(saved.documents) ? saved.documents : clone(materialDocuments);
        this.state.priceHistory = Array.isArray(saved.priceHistory) ? saved.priceHistory : [];
        this.state.reminders = Array.isArray(saved.reminders) ? saved.reminders : [];
        this.state.manualTasks = Array.isArray(saved.manualTasks) ? saved.manualTasks : [];
        this.state.cart = saved.cart && typeof saved.cart === 'object' ? saved.cart : {};
      }
    } catch { /* Recover to the source-backed preview when saved state is invalid. */ }
    for (const id of new Set([...Object.keys(this.state.cart || {}), ...Object.keys(this.state.cartUnits || {})])) {
      if (!this.getProduct(id) || this.getProduct(id).deletedAt) {
        delete this.state.cart?.[id]; delete this.state.cartUnits?.[id];
      }
    }
    // Only the local constructor migrates demo accounts. Server/cloud models
    // use Object.create(KitchenModel.prototype) and never enter this path.
    if (localStoreCodes(this.state)) this.save();
  }

  getStores() { return this.state.stores.filter(store => !store.deletedAt); }
  // Deleted stores remain available for historical orders and documents.
  getStore(id) { return this.state.stores.find(store => store.id === id); }
  getStoreByAccessCode(raw) {
    if (!this.localPreview) return undefined;
    const code = normalizeStoreAccessCode(raw);
    return code ? this.getStores().find(store => normalizeStoreAccessCode(store.accessCode) === code) : undefined;
  }
  getProducts() { return this.state.products.filter(product => !product.deletedAt && !product.catalogueHidden); }
  getQuotedSaleUnits(storeId, productId) {
    return this.getSaleUnits(productId).filter(({ unit }) => Number.isFinite(this.getUnitQuote(storeId, productId, unit).price));
  }
  getOrderableProducts(storeId) {
    return this.getProducts().filter(product => this.getQuotedSaleUnits(storeId, product.id).length > 0);
  }
  normalizeStoreCart(storeId) {
    this.state.cart ||= {}; this.state.cartUnits ||= {};
    const available = new Map(this.getOrderableProducts(storeId).map(product => [product.id, this.getQuotedSaleUnits(storeId, product.id)]));
    for (const id of new Set([...Object.keys(this.state.cart), ...Object.keys(this.state.cartUnits)])) {
      const units = available.get(id);
      if (!units?.length) { delete this.state.cart[id]; delete this.state.cartUnits[id]; continue; }
      const selected = this.state.cartUnits[id] || this.getCartUnit(id);
      if (!units.some(({ unit }) => unit === selected)) delete this.state.cart[id];
    }
    for (const [id, units] of available) {
      const selected = this.state.cartUnits[id] || this.getCartUnit(id);
      if (!units.some(({ unit }) => unit === selected)) this.state.cartUnits[id] = units[0].unit;
    }
  }
  getDeletedProducts() { return this.state.products.filter(product => product.deletedAt).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)); }
  // Keep deleted records addressable so existing order lines can still be
  // displayed, packed and delivered using their original product details.
  getProduct(id) { return this.state.products.find(product => product.id === id); }
  deleteProduct(productId) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    if (product.deletedAt) return product;
    product.deletedAt = new Date().toISOString();
    delete this.state.cart?.[productId];
    delete this.state.cartUnits?.[productId];
    this.save();
    return product;
  }
  restoreProduct(productId) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    if (!product.deletedAt) return product;
    delete product.deletedAt;
    this.save();
    return product;
  }
  setStoreUnitAllocation(storeId, productId, unit, rawQty) {
    const factor = this.getUnitFactor(productId,unit);
    const value = isBlank(rawQty) ? null : quantity(rawQty,unit,'门店可订数量') / factor;
    return this.setStoreAllocation(storeId,productId,value === null ? null : roundQuantity(value,this.getProduct(productId).unit));
  }
  getCartUnit(productId) {
    const units = this.getSaleUnits(productId);
    const saved = this.state.cartUnits?.[productId];
    return units.some(u => u.unit === saved) ? saved : units[0].unit;
  }
  getUnitFactor(productId, unit) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    if (unit === product.unit) return 1;
    const selected = this.getSaleUnits(productId).find(u => u.unit === unit);
    if (!selected) throw new Error('该商品不支持所选售卖单位。');
    return selected.perBase;
  }
  getUnitQuote(storeId, productId, unit) {
    const plan=this.getStoreQuotePlan(storeId);if(plan)return this.getQuotePlanPrice(plan.id,productId,unit);
    const p = this.getProduct(productId);
    this.requireSaleUnit(productId, unit);
    if (!this.getStore(storeId)) throw new Error('门店不存在。');
    const raw = this.state.prices?.[storeId]?.[productId], meta = this.state.quoteMeta?.[storeId]?.[productId] || {};
    const price = isBlank(raw) ? null : Number(raw);
    const quotes = {...this.state.unitQuotes?.[storeId]?.[productId], [p.unit]:{
      price,taxBasis:meta.taxBasis || 'unspecified',taxRate:meta.taxRate ?? null,
      source:meta.source ?? null,kind:meta.kind || (price === null ? 'unquoted' : 'reference'),
    }};
    return resolveUnitPrice(this.getSaleUnits(productId), quotes, unit);
  }
  setUnitQuote(storeId, productId, unit, price, basis = 'unspecified', rate = null) {
    if(this.getStoreQuotePlan(storeId))throw new Error('此门店正在使用报价方案，请修改方案或先切换为独立报价。');
    this.requireSaleUnit(productId, unit);
    if (unit === this.getProduct(productId).unit) return this.setPrice(storeId, productId, price, basis, rate);
    if (!this.getStore(storeId) || this.getStore(storeId).deletedAt) throw new Error('门店不存在或已删除。');
    const next = {price:quotePrice(price),...taxFields(basis, rate),source:'管理员设置',kind:'manual'};
    this.state.unitQuotes ||= {};
    this.state.unitQuotes[storeId] ||= {};
    this.state.unitQuotes[storeId][productId] ||= {};
    this.state.unitQuotes[storeId][productId][unit] = next;
    this.save();
    return next;
  }
  getUnitOrderableStock(storeId, productId, unit) {
    this.requireSaleUnit(productId, unit);
    const factor = this.getUnitFactor(productId, unit), n = this.getOrderableStock(storeId, productId);
    if (n === null) return null;
    const precision = isWeightUnit(unit) ? 1000 : 1;
    const scaled = n * factor * precision;
    const tolerance = Math.min(0.000001, Math.max(1, scaled) * 1e-12);
    return Math.floor(scaled + tolerance) / precision;
  }
  setCartUnit(productId, unit) {
    if (this.getProduct(productId)?.deletedAt) throw new Error('商品已移入回收站，恢复后才可订购。');
    this.requireSaleUnit(productId, unit);
    if (this.getCartUnit(productId) !== unit) delete this.state.cart[productId];
    this.state.cartUnits ||= {};
    this.state.cartUnits[productId] = unit;
    this.save();
  }
  inventoryQuantity(product, raw, label, allowUnknown = true) {
    if (allowUnknown && isBlank(raw)) return null;
    if (!this.getSaleUnits(product.id).some(row => row.unit !== product.unit)) return quantity(raw, product.unit, label, allowUnknown);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1000000000) throw new Error(label + '须为有效的非负数字。');
    return roundQuantity(value, product.unit);
  }
  inventoryTolerance(productId, a, b) {
    // Never use a tolerance approaching one legal purchase increment. This
    // absorbs only arithmetic noise, even for large unit conversion factors.
    const increment = Math.min(...this.getSaleUnits(productId).map(row => (isWeightUnit(row.unit) ? 0.001 : 1) / row.perBase));
    return Math.min(increment / 1000000, Math.max(1, Math.abs(a), Math.abs(b)) * 1e-12);
  }
  getSaleUnits(productId) {
    const p = this.getProduct(productId);
    if (!p) throw new Error('商品不存在。');
    return clone(p.saleUnits || [{ unit: p.unit, perBase: 1 }]);
  }
  requireSaleUnit(productId, unit) {
    if (!this.getSaleUnits(productId).some(row => row.unit === unit)) throw new Error('该商品不支持所选售卖单位。');
    return this.getUnitFactor(productId, unit);
  }
  getSaleUnitEquations(productId) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    if (Array.isArray(product.saleUnitEquations) && product.saleUnitEquations.length
      && product.saleUnitEquations.every(row => [row.fromUnit, row.toUnit].every(unit => SALE_UNIT_OPTIONS.includes(unit)))) return clone(product.saleUnitEquations);
    return unitEquationDefaults(product, this.getSaleUnits(productId));
  }
  setSaleUnitEquations(productId, equations) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    if (!Array.isArray(equations) || !equations.length) throw new Error('请至少保留一组单位换算关系。');
    const clean = equations.map(row => {
      const fromUnit = normalizedSaleUnit(row?.fromUnit), toUnit = normalizedSaleUnit(row?.toUnit);
      if (![fromUnit, toUnit].every(unit => SALE_UNIT_OPTIONS.includes(unit))) throw new Error(`请选择有效单位：${SALE_UNIT_OPTIONS.join('、')}。`);
      const number = value => ['number', 'string'].includes(typeof value) && !isBlank(value) ? Number(value) : NaN;
      const fromQty = number(row.fromQty), toQty = number(row.toQty);
      if ([fromQty, toQty].some(value => !Number.isFinite(value) || value <= 0 || value > 1000000 || !hasPrecision(value, 6))) {
        throw new Error('换算两端的数量须大于 0，最多六位小数。');
      }
      return { fromQty, fromUnit, toQty, toUnit };
    });
    const graph = new Map();
    const edge = (from, to, factor) => {
      if (!graph.has(from)) graph.set(from, []);
      graph.get(from).push({ unit: to, factor });
    };
    for (const row of clean) {
      edge(row.fromUnit, row.toUnit, row.toQty / row.fromQty);
      edge(row.toUnit, row.fromUnit, row.fromQty / row.toQty);
    }
    // Legacy weight bases can still be configured through KG without changing
    // their saved stock/price base, even when that base is now a supported unit.
    const weight = intrinsicWeightKg(product.unit);
    const anchor = weight !== null && !graph.has(product.unit) ? 'KG' : product.unit;
    const factors = new Map([[product.unit, 1], [anchor, anchor === product.unit ? 1 : weight]]), queue = [anchor];
    for (let i = 0; i < queue.length; i++) {
      for (const next of graph.get(queue[i]) || []) {
        const value = factors.get(queue[i]) * next.factor;
        if (factors.has(next.unit)) {
          if (!ratiosAgree(factors.get(next.unit), value)) throw new Error('换算关系相互矛盾，请核对每一组数量。');
        } else {
          if (!Number.isFinite(value) || value < 0.000001 || value > 1000000) throw new Error('换算比例超出支持范围，请调整换算数量。');
          factors.set(next.unit, value);
          queue.push(next.unit);
        }
      }
    }
    if ([...graph.keys()].some(unit => !factors.has(unit))) {
      throw new Error(`所有单位都须通过换算关系连接到库存基础单位 ${product.unit}。`);
    }
    validateFixedWeightUnits(factors);
    const units = [...graph.keys()].map(unit => ({ unit, perBase: factors.get(unit) }));
    if (JSON.stringify(this.getSaleUnits(productId)) !== JSON.stringify(units)) delete this.state.cart[productId];
    product.saleUnits = units;
    product.saleUnitEquations = clean;
    this.save();
    return clone(clean);
  }
  setSaleUnits(productId, rows) {
    const p = this.getProduct(productId);
    if (!p) throw new Error('商品不存在。');
    if (!Array.isArray(rows) || !rows.length) throw new Error('请至少保留一个可售卖单位。');
    const seen = new Set();
    const clean = rows.map(row => {
      const unit = normalizedSaleUnit(row.unit);
      const perBase = Number(row.perBase);
      if (!SALE_UNIT_OPTIONS.includes(unit)) throw new Error(`请选择有效单位：${SALE_UNIT_OPTIONS.join('、')}。`);
      if (seen.has(unit.toLowerCase())) throw new Error('可售卖单位不能重复。');
      if (!Number.isFinite(perBase) || perBase <= 0 || perBase > 1000000 || !hasPrecision(perBase, 6)) throw new Error('换算数量须大于 0，最多六位小数。');
      if (unit.toLowerCase() === p.unit.toLowerCase() && perBase !== 1) throw new Error('库存单位自身的换算数量必须为 1。');
      seen.add(unit.toLowerCase());
      return { unit, perBase };
    });
    validateFixedWeightUnits(new Map([[p.unit, 1], ...clean.map(row => [row.unit, row.perBase])]));
    if (JSON.stringify(this.getSaleUnits(productId)) !== JSON.stringify(clean)) {
      delete this.state.cart[productId];
    }
    p.saleUnits = clean;
    p.saleUnitEquations = unitEquationDefaults(p, clean);
    this.save();
    return clone(clean);
  }
  isStockUnlimited(productId) { return this.getProduct(productId)?.stockUnlimited === true; }
  enableUnlimitedStock(productId) {
    const product=this.getProduct(productId);if(!product||product.deletedAt)throw new Error('商品不存在或已删除。');
    product.stockUnlimited=true;this.save();return {id:productId,stockUnlimited:true};
  }
  setProductCost(productId,value,expectedVersion=null) {
    const product=this.getProduct(productId);if(!product||product.deletedAt)throw new Error('商品不存在或已删除。');
    this.checkEditVersion(product.costVersion,expectedVersion);product.costPrice=quotePrice(value,true);product.costVersion=(product.costVersion||0)+1;this.save();return product;
  }
  getStock(productId) {
    if(this.isStockUnlimited(productId))return null;
    const value = this.state.inventory[productId];
    return isBlank(value) ? null : Number(value);
  }
  getAllocation(storeId, productId) {
    if (!this.getStore(storeId)) throw new Error('门店不存在。');
    if (!this.getProduct(productId)) throw new Error('商品不存在。');
    const value = this.state.storeAllocations?.[storeId]?.[productId];
    return isBlank(value) ? null : Number(value);
  }
  getStoreStock(storeId, productId) { return this.getAllocation(storeId, productId); }
  getAllocatedQty(productId) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    const sum = Object.values(this.state.storeAllocations || {}).reduce((total, allocations) => {
      const value = allocations?.[productId];
      return total + (isBlank(value) ? 0 : Number(value));
    }, 0);
    return roundQuantity(sum, product.unit);
  }
  getOrderableStock(storeId, productId) {
    const allocation = this.getAllocation(storeId, productId);
    if (this.getProduct(productId).deletedAt || this.getStore(storeId).deletedAt) return 0;
    const stock = this.getStock(productId);
    if (stock === null) return allocation;
    const allocated = this.getAllocatedQty(productId);
    // A shared store cannot spend another store's exclusive allocation.
    const available = allocation === null ? stock - allocated : Math.min(allocation, stock - allocated + allocation);
    return roundQuantity(Math.max(0, available), this.getProduct(productId).unit);
  }
  getReservedQty(productId) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    const quantity = this.state.orders.filter(order => ['pending', 'packing', 'ready', 'delivering'].includes(order.stage))
      .reduce((total, order) => total + order.items.filter(item => item.productId === productId)
        .reduce((lineTotal, item) => lineTotal + (item.baseQty ?? item.qty), 0), 0);
    return roundQuantity(quantity, product.unit);
  }
  getWarehouseStock(productId) {
    const available = this.getStock(productId);
    if (available === null) return null;
    return roundQuantity(available + this.getReservedQty(productId), this.getProduct(productId).unit);
  }
  getWarehouseUnitStock(productId, unit) {
    const factor = this.getUnitFactor(productId, unit);
    const total = this.getWarehouseStock(productId);
    if (total === null) return null;
    const value = roundQuantity(total * factor, unit);
    const step = isWeightUnit(unit) ? 0.001 : 1;
    const nativeValue = Math.round(value / step) * step;
    // Suppress only numerical conversion noise in the base pool.
    // Real partial packages (e.g. 0.5 箱) remain partial and are never rounded up.
    const tolerance = Math.min(step / 1000000, Math.max(1, value) * 1e-12);
    return Math.abs(value - nativeValue) <= tolerance ? roundQuantity(nativeValue, unit) : value;
  }
  setWarehouseUnitStock(productId, unit, rawQty) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    const factor = this.getUnitFactor(productId, unit);
    const entered = quantity(rawQty, unit, '实物总库存', true);
    if (entered === null) return this.setWarehouseStock(productId, null);
    // Preserve sufficient base precision for the exact entered unit amount.
    // Order snapshots retain their original quantities when unit ratios change.
    const total = roundQuantity(entered / factor, product.unit);
    if (entered > 0 && total <= 0) throw new Error('盘点数量过小，无法按当前库存精度换算。');
    return this.setWarehouseStock(productId, total);
  }
  setStoreAllocation(storeId, productId, rawQty) {
    if (!this.getStore(storeId) || this.getStore(storeId).deletedAt) throw new Error('门店不存在或已删除。');
    const previous = this.getAllocation(storeId, productId);
    const product = this.getProduct(productId);
    const allocation = this.inventoryQuantity(product, rawQty, '门店配额');
    const allocatedAfter = roundQuantity(this.getAllocatedQty(productId) - (previous ?? 0) + (allocation ?? 0), product.unit);
    const available = this.getStock(productId);
    if (available !== null && allocatedAfter > available + this.inventoryTolerance(productId, allocatedAfter, available)) {
      throw new Error(`门店配额合计 ${allocatedAfter} ${product.unit} 不能超过公司可订库存 ${available} ${product.unit}。`);
    }
    this.state.storeAllocations ||= {};
    this.state.storeAllocations[storeId] ||= {};
    this.state.storeAllocations[storeId][productId] = allocation;
    this.save();
    return allocation;
  }
  setWarehouseStock(productId, rawQty) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    const totalOnHand = this.inventoryQuantity(product, rawQty, '实物总库存');
    const reserved = this.getReservedQty(productId);
    const minimum = roundQuantity(reserved + this.getAllocatedQty(productId), product.unit);
    if (totalOnHand !== null && totalOnHand < minimum - this.inventoryTolerance(productId, totalOnHand, minimum)) {
      throw new Error(`实物总库存不能少于订单占用与门店已分配库存之和（${minimum} ${product.unit}）。`);
    }
    this.setStock(productId, totalOnHand === null ? null : roundQuantity(Math.max(0, totalOnHand - reserved), product.unit));
    return totalOnHand;
  }
  getPrice(storeId, productId) {
    return this.getQuote(storeId, productId).price;
  }
  getQuote(storeId, productId) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    if (this.getSaleUnits(productId).some(row => row.unit === product.unit)) return this.getUnitQuote(storeId, productId, product.unit);
    // A historical base unit can remain an inventory unit after being removed
    // from the sale units. Keep its raw record readable without re-enabling it.
    if (!this.getStore(storeId)) throw new Error('门店不存在。');
    const plan = this.getStoreQuotePlan(storeId);
    const meta = plan ? plan.quotes?.[productId]?.[product.unit] || {} : this.state.quoteMeta?.[storeId]?.[productId] || {};
    const raw = plan ? meta.price : this.state.prices?.[storeId]?.[productId], price = isBlank(raw) ? null : Number(raw);
    return {price,taxBasis:meta.taxBasis || 'unspecified',taxRate:meta.taxRate ?? null,source:clone(meta.source ?? null),kind:meta.kind || (price === null ? 'unquoted' : 'reference')};
  }
  orderSubtotal(order) {
    return roundMoney(order.items.reduce((sum, item) => sum + (isBlank(item.price) ? 0 : roundMoney(item.qty * item.price)), 0));
  }
  orderTotal(order) { return this.orderSubtotal(order); }
  orderUnquotedCount(order) { return order.items.filter(item => item.qty > 0 && isBlank(item.price)).length; }
  orderTaxKnown(order) {
    return order.items.length > 0 && order.items.every(item => !isBlank(item.price)
      && ['exclusive', 'inclusive'].includes(item.taxBasis) && Number.isFinite(item.taxRate));
  }
  orderTax(order) {
    if (!this.orderTaxKnown(order)) return null;
    return roundMoney(order.items.reduce((sum, item) => {
      const amount = item.qty * item.price;
      return sum + (item.taxBasis === 'exclusive' ? amount * item.taxRate : amount - amount / (1 + item.taxRate));
    }, 0));
  }
  status(order) { return order.stage; }
  getQuotePlans() { return this.state.quotePlans||[]; }
  getQuotePlan(id) { return this.getQuotePlans().find(plan=>plan.id===id)||null; }
  getStoreQuotePlan(storeId) { return this.getQuotePlan(this.getStore(storeId)?.quotePlanId); }
  createQuotePlan(name) {
    const value=String(name||'').trim();if(!value||value.length>40||this.getQuotePlans().some(p=>p.name===value))throw new Error('请填写不重复的方案名称（最多 40 字）。');
    const plan={id:'qp-'+crypto.randomUUID(),name:value,quotes:{},version:1};this.state.quotePlans=[...this.getQuotePlans(),plan];this.save();return plan;
  }
  renameQuotePlan(id,name,expectedVersion=null) {
    const plan=this.getQuotePlan(id);if(!plan)throw new Error('报价方案不存在。');this.checkEditVersion(plan.version,expectedVersion);
    const value=String(name||'').trim();if(!value||value.length>40||this.getQuotePlans().some(p=>p.id!==id&&p.name===value))throw new Error('请填写不重复的方案名称（最多 40 字）。');
    plan.name=value;plan.version++;this.save();return plan;
  }
  checkEditVersion(actual,expected) { if(expected!=null&&expected!==(actual||0))throw Object.assign(new Error('资料已被其他操作更新，请刷新后重新核对。'),{status:409}); }
  getQuotePlanPrice(id,productId,unit) {
    const plan=this.getQuotePlan(id);if(!plan)throw new Error('报价方案不存在。');this.requireSaleUnit(productId,unit);
    return resolveUnitPrice(this.getSaleUnits(productId), plan.quotes?.[productId], unit);
  }
  setQuotePlanPrice(id,productId,unit,value,expectedVersion=null) {
    const plan=this.getQuotePlan(id),product=this.getProduct(productId);if(!plan||!product||product.deletedAt)throw new Error('报价方案或商品不存在。');
    this.checkEditVersion(plan.version,expectedVersion);this.requireSaleUnit(productId,unit);
    const price=quotePrice(value.price,true),quote={price,...taxFields(value.taxBasis||'unspecified',value.taxRate??null),source:'管理员设置',kind:price===null?'unquoted':'manual'};
    plan.quotes||={};plan.quotes[productId]||={};plan.quotes[productId][unit]=quote;plan.version++;this.save();return quote;
  }
  setStoreQuotePlan(storeId,planId,expectedVersion=null) {
    const store=this.getStore(storeId);if(!store||store.deletedAt)throw new Error('门店不存在。');
    this.checkEditVersion(store.quoteAssignmentVersion,expectedVersion);
    if(planId!==null&&!this.getQuotePlan(planId))throw new Error('报价方案不存在。');
    if((store.quotePlanId||null)===planId)return store;
    const old=this.getStoreQuotePlan(storeId),next=this.getQuotePlan(planId);if(old)old.version++;if(next)next.version++;
    store.quotePlanId=planId;store.quoteAssignmentVersion=(store.quoteAssignmentVersion||0)+1;this.save();return store;
  }
  setQuotePlanMembers(planId,storeIds,expectedVersion,versions) {
    const plan=this.getQuotePlan(planId);if(!plan)throw new Error('报价方案不存在。');this.checkEditVersion(plan.version,expectedVersion);
    if(!Array.isArray(storeIds)||storeIds.length>200||new Set(storeIds).size!==storeIds.length)throw new Error('门店选择不正确。');
    const stores=this.getStores(),selected=new Set(storeIds);if(storeIds.some(id=>!stores.some(s=>s.id===id)))throw new Error('选择的门店不存在。');
    const changes=stores.filter(store=>selected.has(store.id)?store.quotePlanId!==planId:store.quotePlanId===planId);
    for(const store of changes){if(!Object.hasOwn(versions||{},store.id))throw new Error('请重新打开门店选择。');this.checkEditVersion(store.quoteAssignmentVersion,versions[store.id]);}
    for(const store of changes)this.setStoreQuotePlan(store.id,selected.has(store.id)?planId:null,versions[store.id]);
    this.save();return {id:planId,members:storeIds.length};
  }
  updateManualTask(id,value,expectedVersion=null) {
    const task=this.state.manualTasks?.find(row=>row.id===id&&!row.deletedAt);if(!task||task.source!=='manual')throw new Error('待办不存在。');
    this.checkEditVersion(task.version,expectedVersion);const details=manualTaskDetails(value);
    Object.assign(task,details,{version:(task.version||0)+1,updatedAt:new Date().toISOString()});this.save();return task;
  }
  orderedManualTasks() {
    const ids=this.state.manualTaskOrder||[],rank=new Map(ids.map((id,i)=>[id,i]));
    return (this.state.manualTasks||[]).slice().sort((a,b)=>(rank.get(a.id)??ids.length)-(rank.get(b.id)??ids.length));
  }
  reorderManualTasks(ids,expectedVersion=null) {
    this.checkEditVersion(this.state.manualTaskOrderVersion,expectedVersion);
    if(!Array.isArray(ids)||ids.length>1000||new Set(ids).size!==ids.length||ids.some(id=>!this.state.manualTasks?.some(t=>t.id===id&&!t.deletedAt)))throw new Error('待办排序不正确，请刷新。');
    const selected=new Set(ids);let i=0;this.state.manualTaskOrder=this.orderedManualTasks().map(task=>selected.has(task.id)?ids[i++]:task.id);
    this.state.manualTaskOrderVersion=(this.state.manualTaskOrderVersion||0)+1;this.save();return ids;
  }
  addManualTask(value) {
    const details = manualTaskDetails(value);
    const todos = this.state.manualTasks || [];
    if (todos.length >= 1000) throw new Error('待办记录已达当前上限，请联系平台处理。');
    const now = new Date().toISOString();
    const todo = { id: `todo-${crypto.randomUUID()}`, ...details, source: 'manual',
      createdAt: now, updatedAt: now, completedAt: null, deletedAt: null };
    this.state.manualTasks = [...todos, todo];
    this.save();
    return todo;
  }
  setManualTaskDone(id, done) {
    if (typeof done !== 'boolean') throw new Error('请选择有效的待办状态。');
    const todo = this.state.manualTasks?.find(row => row.id === id && !row.deletedAt);
    if (!todo || todo.source !== 'manual') throw new Error('手动待办不存在。');
    if (Boolean(todo.completedAt) === done) return todo;
    const now = new Date().toISOString();
    todo.completedAt = done ? now : null;
    todo.updatedAt = now;todo.version=(todo.version||0)+1;
    this.save();
    return todo;
  }
  setManualTaskDueDate(id, dueDate) {
    const value=manualTaskDate(dueDate);
    const todo=this.state.manualTasks?.find(row=>row.id===id&&!row.deletedAt);
    if(!todo||todo.source!=='manual')throw new Error('手动待办不存在。');
    if(todo.dueDate===value)return todo;
    todo.dueDate=value;todo.version=(todo.version||0)+1;todo.updatedAt=new Date().toISOString();this.save();return todo;
  }
  purgeManualTask(id, expectedVersion) {
    const task=this.state.manualTasks?.find(row=>row.id===id);
    if(!task||task.source!=='manual')throw new Error('待办不存在。');
    this.checkEditVersion(task.version,expectedVersion);
    this.state.manualTasks=this.state.manualTasks.filter(row=>row.id!==id);
    this.state.manualTaskOrder=(this.state.manualTaskOrder||[]).filter(value=>value!==id);
    this.state.manualTaskOrderVersion=(this.state.manualTaskOrderVersion||0)+1;
    this.save();return {id,permanentlyDeleted:true};
  }
  deleteManualTask(id) {
    const todo = this.state.manualTasks?.find(row => row.id === id);
    if (!todo || todo.source !== 'manual') throw new Error('手动待办不存在。');
    if (todo.deletedAt) return todo;
    todo.deletedAt = new Date().toISOString();todo.version=(todo.version||0)+1;
    todo.updatedAt = todo.deletedAt;
    this.save();
    return todo;
  }
  restoreManualTask(id) {
    const todo = this.state.manualTasks?.find(row => row.id === id);
    if (!todo || todo.source !== 'manual') throw new Error('手动待办不存在。');
    if (!todo.deletedAt) return todo;
    todo.deletedAt = null;todo.version=(todo.version||0)+1;
    todo.updatedAt = new Date().toISOString();
    this.save();
    return todo;
  }
  save() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch { /* Keep the preview usable without persistence. */ }
    return this.state;
  }
  reset() {
    this.state = seedState();
    if (this.localPreview) localStoreCodes(this.state);
    this.save();
    return this.state;
  }

  submitOrder(storeId, cart, deliveryDate = DEMO_DATE, note = '', units = this.state.cartUnits || {}) {
    if (!this.getStore(storeId) || this.getStore(storeId).deletedAt) throw new Error('请选择有效的门店。');
    if (!isDate(deliveryDate)) throw new Error('请选择有效的配送日期。');
    if (deliveryDate < DEMO_DATE) throw new Error('配送日期不能早于今日。');
    if (!cart || typeof cart !== 'object' || Array.isArray(cart)) throw new Error('订货单格式不正确。');
    const items = [];
    for (const [productId, rawQty] of Object.entries(cart)) {
      const product = this.getProduct(productId);
      if (!product) throw new Error('订货单中有不存在的商品。');
      if (product.deletedAt) throw new Error(`${product.name}已移入回收站，恢复后才可订购。`);
      if (rawQty && typeof rawQty === 'object') throw new Error('同一商品只能选择一种单位。');
      const unit = units[productId] || product.unit;
      const factor = this.getUnitFactor(productId,unit);
      const qty = quantity(rawQty, unit, '订货数量');
      if (qty === 0) continue;
      const baseQty = roundQuantity(qty / factor, product.unit);
      if (baseQty <= 0) throw new Error('订购数量过小，无法按当前库存精度换算。');
      const quote = this.getUnitQuote(storeId, productId, unit);
      if (quote.price === null) throw new Error(`${product.name}尚未报价，请联系管理员确认价格后再订购。`);
      const stock = this.getStock(productId);
      if (stock !== null && baseQty > stock + this.inventoryTolerance(productId, baseQty, stock)) throw new Error(`${product.name}库存不足，目前可订 ${stock} ${product.unit}。`);
      if (stock !== null && roundQuantity(Math.max(0, stock - baseQty), product.unit) >= stock) throw new Error('订购数量过小，无法按当前库存精度换算。');
      const orderable = this.getOrderableStock(storeId, productId);
      if (orderable !== null && baseQty > orderable + this.inventoryTolerance(productId, baseQty, orderable)) {
        throw new Error(`${product.name}超出门店可订库存，目前可订 ${orderable} ${product.unit}。`);
      }
      items.push({ productId, qty, price: quote.price, packedQty: 0, unit, baseQty, perBase: factor,
        taxBasis: quote.taxBasis, taxRate: quote.taxRate, quoteSource: quote.source, quoteKind: quote.kind });
    }
    if (!items.length) throw new Error('请先选择需要订购的商品。');
    const prefix = `CK-${deliveryDate.slice(5, 7)}${deliveryDate.slice(8, 10)}`;
    const sequence = Math.max(0, ...this.state.orders.filter(order => order.id.startsWith(prefix)).map(order => Number(order.id.slice(prefix.length)) || 0)) + 1;
    const order = {
      id: `${prefix}${String(sequence).padStart(2, '0')}`, storeId, date: DEMO_DATE, deliveryDate,
      submittedAt: new Date().toISOString(), stage: 'pending', isDemo: true, origin: 'manual_preview', note: String(note).trim(), items,
    };
    // Rejecting any line must preserve the whole draft and inventory.
    for (const item of items) {
      const stock = this.getStock(item.productId);
      if (stock !== null) {
        this.state.inventory[item.productId] = roundQuantity(Math.max(0, stock - item.baseQty), this.getProduct(item.productId).unit);
        this.getProduct(item.productId).stock = this.state.inventory[item.productId];
      }
      const allocation = this.getAllocation(storeId, item.productId);
      if (allocation !== null) this.state.storeAllocations[storeId][item.productId] = roundQuantity(Math.max(0, allocation - item.baseQty), this.getProduct(item.productId).unit);
    }
    this.state.orders.unshift(order);
    this.state.cart = {};
    this.save();
    return order;
  }

  setStage(orderId, stage) {
    const order = this.state.orders.find(item => item.id === orderId);
    if (!order) throw new Error('订单不存在。');
    if (!STAGES.includes(stage)) throw new Error('订单状态不正确。');
    if (order.stage === stage) return order;
    if (order.stage === 'delivered') throw new Error('已送达订单不能修改。');
    if (STAGES.indexOf(stage) !== STAGES.indexOf(order.stage) + 1) throw new Error('请按待配货 → 配货中 → 待配送 → 配送中 → 已送达的顺序更新。');
    if (['ready', 'delivering', 'delivered'].includes(stage) && order.items.some(item => item.packedQty !== item.qty || item.packingConfirmed === false)) {
      throw new Error('尚有商品未配齐，请核对每项数量后再更新配送状态。');
    }
    order.stage = stage;
    if (stage === 'ready') {
      order.readyAt = new Date().toISOString();
      for (const item of order.items) syncPackingIssues(order, item, true, order.readyAt);
    }
    if (stage === 'delivering') order.departedAt = new Date().toISOString();
    if (stage === 'delivered') order.deliveredAt = new Date().toISOString();
    this.save();
    return order;
  }

  packLine(orderId, productId, rawQty) {
    const order = this.state.orders.find(item => item.id === orderId);
    if (!order) throw new Error('订单不存在。');
    if (order.stage === 'delivered') throw new Error('已送达订单不能修改。');
    if (!['pending', 'packing'].includes(order.stage)) throw new Error('订单已进入配送流程，不能修改配货数量。');
    const item = order.items.find(line => line.productId === productId);
    if (!item) throw new Error('订单中没有这项商品。');
    const packedQty = quantity(rawQty, item.unit || this.getProduct(productId)?.unit, '配货数量');
    if (packedQty > item.qty) throw new Error(`配货数量不能超过订货数量 ${item.qty}。`);
    if (item.packedQty !== packedQty) item.packingConfirmed = false;
    item.packedQty = packedQty;
    if (packedQty > 0 && order.stage === 'pending') order.stage = 'packing';
    // A quantity edit is not a packing confirmation. Keep exception history and
    // reopen only exceptions that were resolved by the original checkmark.
    if (!packingLineDone(item)) syncPackingIssues(order, item, false);
    this.save();
    return order;
  }

  confirmPackLine(orderId, productId) {
    const order = this.state.orders.find(item => item.id === orderId);
    if (!order) throw new Error('订单不存在。');
    if (!['pending', 'packing'].includes(order.stage)) throw new Error('订单已进入配送流程，不能修改配货状态。');
    const item = order.items.find(line => line.productId === productId);
    if (!item) throw new Error('订单中没有这项商品。');
    if (item.packedQty !== item.qty) throw new Error('实配数量尚未补全，请先填写全部配货数量。');
    if (isPackingShortage(item) && !item.packingIssue) {
      const now = new Date().toISOString();
      item.packingIssue = { type: 'shortage', status: 'open', reportedAt: now, updatedAt: now };
    }
    item.packingConfirmed = true;
    if (order.stage === 'pending') order.stage = 'packing';
    syncPackingIssues(order, item, true);
    this.save();
    return order;
  }

  setPackLineDone(orderId, productId, done) {
    if (typeof done !== 'boolean') throw new Error('请选择有效的配货状态。');
    const order = this.state.orders.find(item => item.id === orderId);
    if (!order) throw new Error('订单不存在。');
    if (!['pending', 'packing'].includes(order.stage)) throw new Error('订单已进入配送流程，不能修改配货状态。');
    const item = order.items.find(line => line.productId === productId);
    if (!item) throw new Error('订单中没有这项商品。');
    // The checked state confirms the saved order quantity in one operation.
    // An explicit value is safe to repeat after a lost network response.
    // Capture legacy shortages before the completed quantity masks them.
    if (done && isPackingShortage(item) && !item.packingIssue) {
      const now = new Date().toISOString();
      item.packingIssue = { type: 'shortage', status: 'open', reportedAt: now, updatedAt: now };
    }
    item.packedQty = done ? item.qty : 0;
    item.packingConfirmed = done;
    if (done && order.stage === 'pending') order.stage = 'packing';
    syncPackingIssues(order, item, done);
    this.save();
    return order;
  }

  setPackingNote(orderId, productId, note, type) {
    if (typeof note !== 'string' || note.length > 1000) throw new Error('配货备注请填写有效文字，最多 1000 字。');
    if (type !== undefined && !['shortage', 'other'].includes(type)) throw new Error('请选择有效的配货备注类型。');
    const order = this.state.orders.find(item => item.id === orderId);
    if (!order) throw new Error('订单不存在。');
    if (!['pending', 'packing'].includes(order.stage)) throw new Error('订单已进入配送流程，不能修改配货备注。');
    const item = order.items.find(line => line.productId === productId);
    if (!item) throw new Error('订单中没有这项商品。');
    const value = note.trim();
    const nextType = type || (isLegacyShortageNote(value) ? 'shortage' : 'other');
    // Re-saving an unchanged resolved note must not create a new shortage.
    if (value === (item.packingNote || '') && (!value || nextType === (item.packingIssue?.type || (isLegacyShortageNote(value) ? 'shortage' : 'other')))) return order;
    const now = new Date().toISOString();
    if (value) {
      item.packingNote = value;
      item.packingIssue = { type: nextType, status: 'open', reportedAt: now, updatedAt: now };
      if (nextType === 'shortage' && packingLineDone(item)) {
        // Reporting a new shortage after checking requires another physical check.
        item.packingConfirmed = false;
        syncPackingIssues(order, item, false, now);
      }
    } else {
      delete item.packingNote;
      if (item.packingIssue) item.packingIssue = { ...item.packingIssue, status: 'resolved', resolution: 'cleared', updatedAt: now, resolvedAt: now };
    }
    this.save();
    return order;
  }

  resolvePackingIssue(orderId, productId) {
    const order = this.state.orders.find(item => item.id === orderId);
    if (!order) throw new Error('订单不存在。');
    if (!['pending', 'packing', 'ready', 'delivering'].includes(order.stage)) throw new Error('已送达订单不能修改。');
    const item = order.items.find(line => line.productId === productId);
    if (!item) throw new Error('订单中没有这项商品。');
    if (!isPackingShortage(item)) return order;
    const now = new Date().toISOString();
    item.packingIssue = { type: 'shortage', reportedAt: now, ...item.packingIssue,
      status: 'resolved', resolution: 'manual', updatedAt: now, resolvedAt: now };
    this.save();
    return order;
  }

  recordIssue(orderId, note) {
    if (typeof note !== 'string' || !note.trim() || note.trim().length > 1000) throw new Error('异常说明请填写有效文字，最多 1000 字。');
    const order = this.state.orders.find(item => item.id === orderId);
    if (!order) throw new Error('订单不存在。');
    if (order.stage === 'delivered') throw new Error('已送达订单不能修改。');
    const value = note.trim();
    if (order.issue === value && !order.issueResolvedAt) return order;
    order.issue = value; order.issueReportedAt = new Date().toISOString();
    delete order.issueResolvedAt; delete order.issueResolution;
    this.save();
    return order;
  }

  resolveOrderIssue(orderId) {
    const order = this.state.orders.find(item => item.id === orderId);
    if (!order) throw new Error('订单不存在。');
    if (order.stage === 'delivered') throw new Error('已送达订单不能修改。');
    if (!order.issue || order.issueResolvedAt) return order;
    order.issueResolvedAt = new Date().toISOString(); order.issueResolution = 'manual';
    this.save();
    return order;
  }

  setPrice(storeId, productId, rawPrice, taxBasis = 'unspecified', taxRate = null) {
    if(this.getStoreQuotePlan(storeId))throw new Error('此门店正在使用报价方案，请修改方案或先切换为独立报价。');
    if (!this.getStore(storeId) || this.getStore(storeId).deletedAt) throw new Error('门店不存在或已删除。');
    if (!this.getProduct(productId)) throw new Error('商品不存在。');
    const price = quotePrice(rawPrice);
    const taxes = taxFields(taxBasis, taxRate);
    const previous = this.getQuote(storeId, productId);
    const quote = { ...taxes, source: '管理员设置', kind: 'manual' };
    this.state.prices[storeId] ||= {};
    this.state.quoteMeta[storeId] ||= {};
    this.state.prices[storeId][productId] = price;
    this.state.quoteMeta[storeId][productId] = quote;
    this.state.priceHistory.unshift({ storeId, productId, previous, next: { price, ...quote }, changedAt: new Date().toISOString() });
    this.save();
    return price;
  }

  addProduct({ name, category, unit, spec, basePrice = null, stock = null, description = '', icon = '', image = null }) {
    const normalizedName = String(name || '').trim();
    const normalizedUnit = String(unit || '').trim();
    if (!normalizedName || !normalizedUnit) throw new Error('请填写商品名称和计价单位。');
    if (!categories.includes(category)) throw new Error('请选择有效的商品分类。');
    const normalizedSpec = String(spec || '').trim() || normalizedUnit;
    const duplicate = this.state.products.find(product => product.name.toLocaleLowerCase() === normalizedName.toLocaleLowerCase()
      && product.unit === normalizedUnit && product.spec === normalizedSpec);
    if (duplicate) throw new Error(duplicate.deletedAt
      ? '这个名称、规格和计价单位的商品已在回收站，请前往回收站恢复。'
      : '这个名称、规格和计价单位的商品已存在。');
    if (image !== null && (typeof image !== 'string' || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(image) || image.length > 1200000)) throw new Error('请上传有效的 PNG、JPEG 或 WebP 图片。');
    const price = quotePrice(basePrice, true);
    const availableStock = quantity(stock, normalizedUnit, '可订库存', true);
    const nextNumber = Math.max(0, ...this.state.products.map(product => Number(product.id.replace(/\D/g, '')) || 0)) + 1;
    const product = {
      id: `manual-${String(nextNumber).padStart(3, '0')}`, name: normalizedName, category,
      unit: normalizedUnit, spec: normalizedSpec,
      basePrice: price, stock: availableStock, description: String(description).trim(), image,
      icon: String(icon).trim() || { 冷冻品: '❄️', 常温品: '📦', 蔬菜品: '🥬', 饮品: '🥤', 干调类: '🧂', 代买品: '🛒', 其他食材: '🍽️' }[category],
      sku: `NEW-${String(nextNumber).padStart(3, '0')}`, source: '管理员新增',
    };
    this.state.products.push(product);
    this.state.inventory[product.id] = availableStock;
    for (const store of this.getStores()) {
      this.state.prices[store.id] ||= {};
      this.state.quoteMeta[store.id] ||= {};
      this.state.prices[store.id][product.id] = price;
      this.state.quoteMeta[store.id][product.id] = { taxBasis: 'unspecified', taxRate: null, source: '管理员新增参考报价', kind: price === null ? 'unquoted' : 'reference' };
    }
    this.save();
    return product;
  }

  setStock(productId, rawQty) {
    const product = this.getProduct(productId);
    if (!product) throw new Error('商品不存在。');
    const qty = this.inventoryQuantity(product, rawQty, '可订库存');
    const allocated = this.getAllocatedQty(productId);
    if (qty !== null && qty < allocated - this.inventoryTolerance(productId, qty, allocated)) throw new Error(`公司可订库存不能少于门店已分配库存 ${allocated} ${product.unit}。`);
    this.state.inventory[productId] = qty;
    product.stock = qty;product.stockUnlimited=false;
    this.save();
    return qty;
  }

  addStore(value) {
    const details = storeDetails(value);
    if (details.account && this.state.stores.some(store => String(store.account || '').toLowerCase() === details.account.toLowerCase())) throw new Error('这个登录账号已被使用，请换一个。');
    const nextNumber = this.state.stores.length + 1;
    let id = `s-manual-${String(nextNumber).padStart(2, '0')}`;
    while (this.getStore(id)) id += '-new';
    const store = {
      id, ...details, color: '#3b8f7a', route: '待分配',
    };
    if (this.localPreview) store.accessCode = newStoreAccessCode(new Set(this.state.stores.map(item => normalizeStoreAccessCode(item.accessCode))));
    this.state.stores.push(store);
    this.state.storeAllocations ||= {};
    this.state.storeAllocations[store.id] = {};
    this.state.prices[store.id] = Object.fromEntries(this.state.products.map(product => [product.id, product.basePrice ?? null]));
    this.state.quoteMeta[store.id] = Object.fromEntries(this.state.products.map(product => [product.id, {
      taxBasis: 'unspecified', taxRate: null, source: clone(product.quoteSource ?? null),
      kind: product.basePrice === null || product.basePrice === undefined ? 'unquoted' : 'reference',
    }]));
    this.save();
    return store;
  }

  updateStore(storeId, value) {
    const store = this.getStore(storeId);
    if (!store || store.deletedAt) throw new Error('门店不存在或已删除。');
    const editable = new Set(['name', 'city', 'address', 'contact', 'phone', 'image', 'prefecture', 'municipality', 'ward', 'addressDetail', 'prefectureCode', 'municipalityCode', 'wardCode']);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !editable.has(key))) throw new Error('门店编辑字段不正确。');
    const changes = { ...value };
    const has = key => Object.prototype.hasOwnProperty.call(changes, key);
    if (((has('city') && changes.city !== store.city) || (has('address') && changes.address !== store.address))
      && !['prefectureCode', 'municipalityCode', 'wardCode'].some(has)) {
      Object.assign(changes, { prefecture: '', municipality: '', ward: '', prefectureCode: '', municipalityCode: '', wardCode: '' });
    }
    const details = storeDetails({ ...store, ...changes });
    if (details.account && this.state.stores.some(other => other.id !== storeId
      && String(other.account || '').toLowerCase() === details.account.toLowerCase())) throw new Error('这个登录账号已被使用，请换一个。');
    Object.assign(store, details);
    this.save();
    return store;
  }

  deleteStore(storeId) {
    const store = this.getStore(storeId);
    if (!store) throw new Error('门店不存在。');
    if (store.deletedAt) return store;
    store.deletedAt = new Date().toISOString();
    // Orders already reserve their own quantities. Only unused store quotas
    // return to the shared pool; history and negotiated prices stay intact.
    delete this.state.storeAllocations?.[storeId];
    if (this.state.activeStoreId === storeId) {
      this.state.activeStoreId = this.getStores()[0]?.id || '';
      this.state.cart = {}; this.state.cartUnits = {};
    }
    this.save();
    return store;
  }

  remindOrder(orderId) {
    const order = this.state.orders.find(item => item.id === orderId);
    if (!order) throw new Error('订单不存在。');
    if (order.stage === 'delivered') throw new Error('订单已送达，无需催单。');
    const reminder = { id: `rem-${Date.now()}-${this.state.reminders.length}`, orderId, createdAt: new Date().toISOString() };
    this.state.reminders.unshift(reminder);
    this.save();
    return reminder;
  }
}
