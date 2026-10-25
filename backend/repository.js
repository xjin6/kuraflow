import { KitchenModel, SALE_UNIT_OPTIONS } from '../src/shared/data.js';
import { resolveJapanAddress } from '../src/shared/japan-addresses.js';
import { deriveNotificationEvents } from '../src/shared/notification-domain.js';
import { notificationStatements } from './notifications.js';

const MAX_ACTIVE_ORDERS = 1000;
const MAX_PRODUCTS = 5000;
const MAX_STORES = 200;
const MAX_DOCUMENTS = 1000;
const MAX_HISTORY = 200;
const COMMANDS = new Set([
  'updateManualTask','reorderManualTasks','setProductCost','enableUnlimitedStock','createQuotePlan','renameQuotePlan','setQuotePlanPrice','setStoreQuotePlan','setQuotePlanMembers',
  'applyAttachmentRows',
  'setWarehouseStock', 'setStoreAllocation', 'setStoreUnitAllocation',
  'setPrice', 'setUnitQuote', 'setSaleUnits', 'setSaleUnitEquations', 'setWarehouseUnitStock', 'addProduct', 'deleteProduct', 'restoreProduct', 'addStore', 'updateStore', 'deleteStore',
  'submitOrder', 'setStage', 'packLine', 'confirmPackLine', 'setPackLineDone', 'setPackingNote', 'resolvePackingIssue', 'remindOrder', 'recordIssue', 'resolveOrderIssue', 'confirmDelivery', 'setStock', 'importProducts',
  'purgeManualTask', 'addManualTask', 'setManualTaskDone', 'setManualTaskDueDate', 'deleteManualTask', 'restoreManualTask',
]);
const STORE_COMMANDS = new Set(['submitOrder', 'remindOrder', 'recordIssue', 'confirmDelivery']);
const clone = value => value !== null && typeof value === 'object' ? structuredClone(value) : value;
const json = value => JSON.stringify(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class RepositoryError extends Error {
  constructor(message, status = 400, code = 'INVALID_COMMAND') {
    super(message);
    this.name = 'RepositoryError';
    this.status = status;
    this.code = code;
  }
}

function reject(message, status = 400, code = 'INVALID_COMMAND') {
  throw new RepositoryError(message, status, code);
}

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value)
    || ['__proto__', 'constructor', 'prototype'].includes(value)) reject(`${label}不正确。`);
  return value;
}

function principalScope(principal) {
  if (!principal || !['admin', 'store'].includes(principal.role)) reject('请先登录。', 401, 'UNAUTHORIZED');
  identifier(principal.tenantId, '公司');
  identifier(principal.userId, '用户');
  if (principal.role === 'store') identifier(principal.storeId, '门店');
  return principal;
}

function textField(value, label, max, required = false) {
  if (value == null && !required) return;
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) reject(`${label}请填写有效文字，最多 ${max} 字。`);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject(`${label}格式不正确。`);
}

function inspectJson(value, depth = 0) {
  if (depth > 12) reject('数据层级过多。');
  if (typeof value === 'number' && !Number.isFinite(value)) reject('数字格式不正确。');
  if (typeof value === 'string' && value.length > 1200000) reject('输入内容过长。');
  if (value && typeof value === 'object') {
    if (!Array.isArray(value)) plainObject(value, '数据');
    for (const [key, next] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) reject('数据字段不正确。');
      inspectJson(next, depth + 1);
    }
  } else if (value !== null && !['string', 'number', 'boolean', 'undefined'].includes(typeof value)) reject('数据格式不正确。');
}

export function tokyoToday() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function modelFor(state) {
  const model = Object.create(KitchenModel.prototype);
  model.state = state;
  model.storage = null;
  model.save = () => model.state;
  return model;
}

function boundedCore(state) {
  const { products, orders, documents, revision, privateMaterials, ...core } = state;
  return {
    ...core, cart: {}, cartUnits: {},
    priceHistory: (core.priceHistory || []).slice(0, MAX_HISTORY),
    reminders: (core.reminders || []).slice(0, MAX_HISTORY),
  };
}

async function readSnapshot(db, tenantId, storeId = null) {
  identifier(tenantId, '公司');
  const orderScope = storeId ? ' AND store_id = ?' : '';
  const bindings = storeId ? [tenantId, storeId] : [tenantId];
  const [tenantResult, productResult, orderResult, documentResult] = await db.batch([
    db.prepare('SELECT core_json, revision FROM tenants WHERE id = ?').bind(tenantId),
    db.prepare('SELECT data_json FROM products WHERE tenant_id = ? ORDER BY rowid LIMIT ?').bind(tenantId, MAX_PRODUCTS + 1),
    db.prepare(`SELECT data_json, stage FROM (
      SELECT data_json, stage, created_at FROM orders WHERE tenant_id = ?${orderScope} AND stage != 'delivered' ORDER BY created_at DESC LIMIT ${MAX_ACTIVE_ORDERS + 1}
    ) UNION ALL SELECT data_json, stage FROM (
      SELECT data_json, stage, created_at FROM orders WHERE tenant_id = ?${orderScope} AND stage = 'delivered' ORDER BY created_at DESC LIMIT 100
    )`).bind(...bindings, ...bindings),
    db.prepare(`SELECT data_json FROM documents WHERE tenant_id = ?${storeId ? ' AND store_id = ?' : ''} ORDER BY created_at DESC LIMIT ?`)
      .bind(...bindings, MAX_DOCUMENTS + 1),
  ]);
  const tenant = tenantResult.results[0];
  if (!tenant) reject('公司资料尚未初始化。', 404, 'TENANT_NOT_FOUND');
  if (productResult.results.length > MAX_PRODUCTS) reject('商品数量超过当前加载上限。', 409, 'CAPACITY_LIMIT');
  if (orderResult.results.filter(row => row.stage !== 'delivered').length > MAX_ACTIVE_ORDERS) {
    reject('未完成订单超过当前处理上限，请先联系管理员处理积压订单。', 409, 'ACTIVE_ORDER_LIMIT');
  }
  if (documentResult.results.length > MAX_DOCUMENTS) reject('单据数量超过当前加载上限，请联系管理员归档。', 409, 'CAPACITY_LIMIT');
  const core = JSON.parse(tenant.core_json);
  const state = {
    ...core,
    products: productResult.results.map(row => JSON.parse(row.data_json)),
    orders: orderResult.results.map(row => JSON.parse(row.data_json)),
    documents: documentResult.results.map(row => JSON.parse(row.data_json)),
    cart: {}, cartUnits: {},
  };
  return { state, revision: tenant.revision };
}

export async function loadState(db, tenantId) {
  return readSnapshot(db, tenantId);
}

function select(value, keys) {
  return Object.fromEntries(keys.filter(key => own(value, key)).map(key => [key, clone(value[key])]));
}

function safeQuote(quote = {}) {
  return { price: quote.price ?? null, taxBasis: quote.taxBasis || 'unspecified', taxRate: quote.taxRate ?? null, kind: quote.price == null ? 'unquoted' : 'listed', source: null };
}

function safeOrder(order) {
  const result = select(order, ['id', 'storeId', 'storeName', 'date', 'deliveryDate', 'submittedAt', 'stage', 'isDemo', 'origin', 'note', 'departedAt', 'deliveredAt', 'receivedBy', 'issue', 'issueReportedAt', 'issueResolvedAt', 'shipping', 'shippingTax']);
  result.items = (order.items || []).map(item => select(item, ['productId', 'productName', 'spec', 'qty', 'price', 'packedQty', 'packingConfirmed', 'unit', 'baseQty', 'perBase', 'taxBasis', 'taxRate', 'quoteKind']));
  return result;
}

function safeDocument(document) {
  const result = select(document, ['id', 'title', 'type', 'date', 'customer', 'storeId', 'number', 'period', 'dueDate', 'paymentStatus', 'shipping', 'shippingTax', 'issuer']);
  result.totals = select(document.totals || {}, ['net', 'tax', 'total', 'subtotalPrinted', 'taxPrinted', 'grandTotalPrinted', 'lineAmountsSumExact', 'subtotalPrintedMinusLineSum']);
  result.lines = (document.lines || []).map(line => select(line, ['productId', 'productName', 'descriptionRaw', 'specRaw', 'quantity', 'unit', 'unitNormalized', 'quantityMode', 'unitPrice', 'priceTaxBasis', 'lineAmount', 'currency', 'taxRatePercent', 'qty', 'price', 'unitRaw', 'net', 'tax', 'total', 'lineType', 'category', 'transactionDate']));
  return result;
}

function projectState(state, principal) {
  if (principal.role === 'admin') {
    // Each DB snapshot belongs to this request; only the top-level omission
    // needs a new object. No shared cache or caller-owned state is exposed.
    const result = { ...state };
    delete result.privateMaterials;
    return result;
  }
  const sid = principal.storeId;
  const model = modelFor(state);
  const store = model.getStore(sid);
  if (!store || store.deletedAt) reject('门店账号未关联有效门店。', 403, 'STORE_NOT_FOUND');
  const ownOrders = state.orders.filter(order => order.storeId === sid);
  const orderIds = new Set(ownOrders.map(order => order.id));
  const referencedProducts = new Set(ownOrders.flatMap(order => order.items.map(item => item.productId)));
  const catalogueIds = new Set(model.getOrderableProducts(sid).map(product => product.id));
  const visibleProducts = state.products.filter(product => catalogueIds.has(product.id) || referencedProducts.has(product.id));
  const visibleIds = new Set(visibleProducts.map(product => product.id));
  const visibleEntries = values => Object.entries(values || {}).filter(([pid]) => visibleIds.has(pid));
  const inventory = Object.fromEntries(visibleProducts.map(product => [product.id, model.getOrderableStock(sid, product.id)]));
  return {
    version: state.version || 2,
    products: visibleProducts.map(product => ({
      // Retain deleted records for historical order lines; their marker keeps
      // them out of the store catalogue and clears stale browser cart drafts.
      ...select(product, ['id', 'name', 'familyName', 'category', 'unit', 'spec', 'icon', 'description', 'temperature', 'image', 'saleUnits', 'deletedAt']),
      catalogueHidden: !catalogueIds.has(product.id), basePrice: null, stock: inventory[product.id], stockUnlimited:model.isStockUnlimited(product.id)&&model.getAllocation(sid,product.id)===null,
    })),
    stores: [select(store, ['id', 'name', 'city', 'prefecture', 'municipality', 'ward', 'addressDetail', 'address', 'phone', 'contact', 'color', 'route', 'image'])],
    prices: { [sid]: Object.fromEntries(visibleProducts.map(product => [product.id, model.getPrice(sid, product.id)])) },
    quoteMeta: { [sid]: Object.fromEntries(visibleProducts.map(product => [product.id, safeQuote(model.getQuote(sid, product.id))])) },
    unitQuotes: { [sid]: Object.fromEntries(visibleProducts.map(product=>[product.id,Object.fromEntries(model.getSaleUnits(product.id).map(({unit})=>[unit,safeQuote(model.getUnitQuote(sid,product.id,unit))]))])) },
    // These are already this store's orderable quantities. Leaving allocations
    // empty prevents the browser model from subtracting reservations a second time.
    inventory, storeAllocations: {},
    orders: ownOrders.map(safeOrder),
    documents: state.documents.filter(document => document.storeId === sid).map(safeDocument),
    reminders: (state.reminders || []).filter(reminder => orderIds.has(reminder.orderId)).map(reminder => select(reminder, ['id', 'orderId', 'createdAt'])),
    settings: select(state.settings || {}, ['companyName', 'cutoffTime', 'deliveryWindow', 'currency', 'language']),
    materialSummary: {}, priceHistory: [], activeStoreId: sid, cart: {}, cartUnits: {},
  };
}

export async function getState(db, principal) {
  principalScope(principal);
  const snapshot = await readSnapshot(db, principal.tenantId, principal.role === 'store' ? principal.storeId : null);
  return { state: projectState(snapshot.state, principal), revision: snapshot.revision };
}

// Reporting reads completed history separately from the small operational state.
// A revision check prevents mixing pages from different business snapshots.
export async function getOrderHistory(db, principal, {cursor=0,revision}={}) {
  principalScope(principal);
  if (!Number.isSafeInteger(cursor) || cursor<0 || !Number.isSafeInteger(revision) || revision<0) reject('历史订单分页参数不正确。');
  const bindings = principal.role==='store' ? [principal.tenantId,principal.storeId,cursor] : [principal.tenantId,cursor];
  const [tenantResult,rows] = await db.batch([
    db.prepare('SELECT revision,core_json FROM tenants WHERE id=?').bind(principal.tenantId),
    db.prepare(`SELECT rowid AS cursor,data_json FROM orders WHERE tenant_id=? ${principal.role==='store'?'AND store_id=?':''}
      AND stage='delivered' AND rowid>? ORDER BY rowid LIMIT 101`).bind(...bindings),
  ]);
  const tenant=tenantResult.results[0];
  if (!tenant) reject('公司资料尚未初始化。',404,'TENANT_NOT_FOUND');
  if (principal.role==='store' && !JSON.parse(tenant.core_json).stores.some(store=>store.id===principal.storeId&&!store.deletedAt)) reject('门店已停用。',403,'STORE_NOT_FOUND');
  if (tenant.revision!==revision) reject('订单已更新，请重新加载统计。',409,'HISTORY_CHANGED');
  const page=rows.results.slice(0,100),orders=page.map(row=>JSON.parse(row.data_json));
  let products=[];
  if(principal.role==='store' && orders.length) {
    const ids=[...new Set(orders.flatMap(order=>(order.items||[]).map(item=>item.productId)))];
    const result=await db.prepare('SELECT data_json FROM products WHERE tenant_id=? AND id IN (SELECT value FROM json_each(?))')
      .bind(principal.tenantId,JSON.stringify(ids)).all();
    products=result.results.map(row=>({...select(JSON.parse(row.data_json),['id','name','familyName','category','unit','spec','icon','description','temperature','image','saleUnits','deletedAt']),catalogueHidden:true,basePrice:null,stock:0}));
  }
  // The store projection excludes costs, quote provenance and other stores.
  return {revision,orders:principal.role==='admin'?orders:orders.map(safeOrder),products,nextCursor:rows.results.length>100?page.at(-1).cursor:null};
}

export async function getPrivateMaterials(db, principal) {
  principalScope(principal);
  if (principal.role !== 'admin') reject('只有管理员可以查看采购资料。', 403, 'FORBIDDEN');
  const row = await db.prepare(`SELECT tenants.name, private_materials.data_json FROM tenants
    LEFT JOIN private_materials ON private_materials.tenant_id = tenants.id WHERE tenants.id = ?`).bind(principal.tenantId).first();
  if (!row) reject('公司资料尚未初始化。', 404, 'TENANT_NOT_FOUND');
  return { materialCosts: [], procurementAttachment: [], company: { name: row.name }, ...JSON.parse(row.data_json || '{}') };
}

function changedRows(previous, next) {
  const byId = new Map(previous.map(value => [value.id, json(value)]));
  return next.filter(value => byId.get(value.id) !== json(value));
}

function entityStatements(db, tenantId, changes) {
  const statements = [];
  if (changes.products.length) statements.push(db.prepare(`INSERT INTO products (tenant_id, id, data_json)
    SELECT ?, json_extract(value, '$.id'), value FROM json_each(?) WHERE 1
    ON CONFLICT(tenant_id, id) DO UPDATE SET data_json = excluded.data_json`).bind(tenantId, json(changes.products)));
  if (changes.orders.length) statements.push(db.prepare(`INSERT INTO orders (tenant_id, id, store_id, stage, data_json, created_at)
    SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.storeId'), json_extract(value, '$.stage'), value, json_extract(value, '$.submittedAt') FROM json_each(?) WHERE 1
    ON CONFLICT(tenant_id, id) DO UPDATE SET stage = excluded.stage, data_json = excluded.data_json`).bind(tenantId, json(changes.orders)));
  if (changes.documents.length) statements.push(db.prepare(`INSERT INTO documents (tenant_id, id, store_id, data_json, created_at)
    SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.storeId'), value, coalesce(json_extract(value, '$.date'), '') FROM json_each(?) WHERE 1
    ON CONFLICT(tenant_id, id) DO UPDATE SET data_json = excluded.data_json, store_id = excluded.store_id`).bind(tenantId, json(changes.documents)));
  return statements;
}

function validateCommand(principal, command) {
  plainObject(command, '操作');
  inspectJson(command);
  if (!COMMANDS.has(command.type)) reject('不支持这项操作。', 400, 'UNKNOWN_COMMAND');
  if (!Array.isArray(command.args) || command.args.length > 6) reject('操作参数不正确。');
  identifier(command.idempotencyKey, '请求编号');
  if (principal.role === 'store' && !STORE_COMMANDS.has(command.type)) reject('门店账号不能执行这项管理操作。', 403, 'FORBIDDEN');
  const versionAt=index=>{if(!Number.isSafeInteger(command.args[index])||command.args[index]<0)reject('请刷新页面后重新编辑。');};
  if(command.type==='purgeManualTask'){if(command.args.length!==2)reject('待办参数不正确。');identifier(command.args[0],'待办');versionAt(1);}
  if(command.type==='updateManualTask'){if(command.args.length!==3)reject('待办参数不正确。');identifier(command.args[0],'待办');versionAt(2);plainObject(command.args[1],'待办');}
  if(command.type==='reorderManualTasks'){if(command.args.length!==2||!Array.isArray(command.args[0])||command.args[0].length>1000)reject('待办顺序不正确。');command.args[0].forEach(id=>identifier(id,'待办'));versionAt(1);}
  if(command.type==='setProductCost'){if(command.args.length!==3)reject('成本价参数不正确。');identifier(command.args[0],'商品');versionAt(2);}
  if(command.type==='enableUnlimitedStock'){if(command.args.length!==1)reject('库存参数不正确。');identifier(command.args[0],'商品');}
  if(command.type==='createQuotePlan'){if(command.args.length!==1)reject('方案参数不正确。');textField(command.args[0],'方案名称',40,true);}
  if(command.type==='renameQuotePlan'){if(command.args.length!==3)reject('方案参数不正确。');identifier(command.args[0],'方案');textField(command.args[1],'方案名称',40,true);versionAt(2);}
  if(command.type==='setQuotePlanPrice'){if(command.args.length!==5)reject('方案报价参数不正确。');identifier(command.args[0],'方案');identifier(command.args[1],'商品');textField(command.args[2],'单位',20,true);plainObject(command.args[3],'报价');if(Object.keys(command.args[3]).some(k=>!['price','taxBasis','taxRate'].includes(k)))reject('报价字段不正确。');versionAt(4);}
  if(command.type==='setStoreQuotePlan'){if(command.args.length!==3)reject('门店方案参数不正确。');identifier(command.args[0],'门店');if(command.args[1]!==null)identifier(command.args[1],'方案');versionAt(2);}
  if(command.type==='setQuotePlanMembers'){if(command.args.length!==4||!Array.isArray(command.args[1])||command.args[1].length>200)reject('方案门店不正确。');identifier(command.args[0],'方案');command.args[1].forEach(id=>identifier(id,'门店'));versionAt(2);plainObject(command.args[3],'门店版本');if(Object.keys(command.args[3]).length>200)reject('门店过多。');}
  if(command.type==='applyAttachmentRows') {
    const rows=command.args[0];
    if(command.args.length!==1||!Array.isArray(rows)||!rows.length||rows.length>20)reject('每批可导入 1～20 行。');
    const seen=new Set();
    for(const row of rows){
      plainObject(row,'导入行');if(!['setUnitQuote','setWarehouseUnitStock'].includes(row.type)||Object.keys(row).some(k=>!['type','args'].includes(k)))reject('导入仅支持销售报价与实物总库存。');
      validateCommand(principal,{...row,idempotencyKey:command.idempotencyKey});
      const key=JSON.stringify([row.type,...row.args.slice(0,row.type==='setUnitQuote'?3:1)]);
      if(seen.has(key))reject('同一商品的库存或同一门店商品单位的报价不能在一批中重复。');seen.add(key);
    }
  }
  if (command.type === 'addManualTask') {
    if (command.args.length !== 1) reject('待办操作参数不正确。');
    plainObject(command.args[0], '待办内容');
    if (Object.keys(command.args[0]).some(key => !['title', 'note', 'dueDate'].includes(key))) reject('待办内容字段不正确。');
    textField(command.args[0].title, '待办事项', 120, true);
    textField(command.args[0].note, '备注', 500);
    textField(command.args[0].dueDate, '截止日期', 10, true);
  }
  if (['setManualTaskDone', 'setManualTaskDueDate', 'deleteManualTask', 'restoreManualTask'].includes(command.type)) {
    if (command.args.length !== (['setManualTaskDone', 'setManualTaskDueDate'].includes(command.type) ? 2 : 1)) reject('待办操作参数不正确。');
    identifier(command.args[0], '待办');
    if (command.type === 'setManualTaskDone' && typeof command.args[1] !== 'boolean') reject('请选择有效的待办状态。');
    if (command.type === 'setManualTaskDueDate') textField(command.args[1], '截止日期', 10, true);
  }
  if (['deleteProduct', 'restoreProduct'].includes(command.type)) {
    if (command.args.length !== 1) reject('商品操作参数不正确。');
    identifier(command.args[0], '商品');
  }
  if (command.type === 'deleteStore') {
    if (command.args.length !== 1) reject('门店操作参数不正确。');
    identifier(command.args[0], '门店');
  }
  if (['confirmPackLine', 'resolvePackingIssue'].includes(command.type)) {
    if (command.args.length !== 2) reject('配货操作参数不正确。');
    identifier(command.args[0], '订单'); identifier(command.args[1], '商品');
  }
  if (['setPackLineDone', 'setPackingNote'].includes(command.type)) {
    if (command.type === 'setPackLineDone' ? command.args.length !== 3 : ![3, 4].includes(command.args.length)) reject('配货操作参数不正确。');
    identifier(command.args[0], '订单'); identifier(command.args[1], '商品');
    if (command.type === 'setPackLineDone' && typeof command.args[2] !== 'boolean') reject('请选择有效的配货状态。');
    if (command.type === 'setPackingNote') {
      if (typeof command.args[2] !== 'string') reject('配货备注请填写有效文字，最多 1000 字。');
      textField(command.args[2], '配货备注', 1000);
      if (command.args.length === 4 && !['shortage', 'other'].includes(command.args[3])) reject('请选择有效的配货备注类型。');
    }
  }
  if (command.type === 'recordIssue') {
    if (command.args.length !== 2) reject('异常操作参数不正确。');
    identifier(command.args[0], '订单');
    textField(command.args[1], '异常说明', 1000, true);
  }
  if (command.type === 'resolveOrderIssue') {
    if (command.args.length !== 1) reject('异常操作参数不正确。');
    identifier(command.args[0], '订单');
  }
  if (command.type === 'submitOrder') {
    identifier(command.args[0], '门店');
    if (principal.role === 'store' && command.args[0] !== principal.storeId) reject('只能为自己的门店订货。', 403, 'FORBIDDEN');
    plainObject(command.args[1], '购物车');
    if (Object.keys(command.args[1]).length > 100) reject('每张订单最多包含 100 种商品。');
    for (const id of Object.keys(command.args[1])) identifier(id, '商品');
    textField(command.args[2], '配送日期', 10, true);
    if (command.args[2] < tokyoToday()) reject('配送日期不能早于日本当地今日。');
    textField(command.args[3], '订单备注', 1000);
    if (command.args[4] != null) {
      plainObject(command.args[4], '售卖单位');
      if (Object.keys(command.args[4]).length > 100) reject('售卖单位数量过多。');
      for (const [id, unit] of Object.entries(command.args[4])) {
        identifier(id, '商品');
        if (!SALE_UNIT_OPTIONS.includes(unit)) reject('请选择有效售卖单位。');
      }
    }
    if (command.expectedQuotes != null || principal.role === 'store') plainObject(command.expectedQuotes, '报价');
    if (command.expectedQuotes != null) {
      if (Object.keys(command.expectedQuotes).length > 100) reject('报价数量过多。');
      for (const [pid, qty] of Object.entries(command.args[1])) {
        if (!(Number(qty) > 0)) continue;
        const expected = command.expectedQuotes[pid];
        plainObject(expected, '报价');
        if (['unit', 'price', 'taxBasis', 'taxRate', 'perBase'].some(key => !own(expected, key))) reject('报价信息不完整，请刷新订货单后重试。', 409, 'QUOTE_CHANGED');
      }
    }
  }
  if (command.type === 'addProduct') {
    const value = command.args[0];
    plainObject(value, '商品');
    textField(value.name, '商品名称', 120, true);
    textField(value.spec, '规格', 200);
    textField(value.description, '商品详情', 4000);
    textField(value.icon, '图标', 32);
    if (!SALE_UNIT_OPTIONS.includes(value.unit)) reject('请选择有效计价单位。');
    if (value.image != null && typeof value.image !== 'string') reject('商品图片格式不正确。');
  }
  if (['addStore', 'updateStore'].includes(command.type)) {
    const editing = command.type === 'updateStore';
    if (command.args.length !== (editing ? 2 : 1)) reject('门店操作参数不正确。');
    if (editing) identifier(command.args[0], '门店');
    const value = command.args[editing ? 1 : 0];
    plainObject(value, '门店');
    const fields = new Set(['name', 'city', 'address', 'contact', 'phone', 'image', 'prefecture', 'municipality', 'ward', 'addressDetail', 'prefectureCode', 'municipalityCode', 'wardCode', ...(editing ? [] : ['account'])]);
    if (Object.keys(value).some(key => !fields.has(key))) reject('门店编辑字段不正确。');
    textField(value.name, '门店名称', 120, !editing || own(value, 'name'));
    for (const key of ['contact', 'phone', 'addressDetail']) textField(value[key], '门店信息', key === 'addressDetail' ? (editing ? 500 : 180) : 120, !editing);
    for (const key of ['city', 'address', 'prefecture', 'municipality', 'ward', 'account']) textField(value[key], '门店信息', key === 'address' ? 500 : 120);
    if (!editing || ['prefectureCode', 'municipalityCode', 'wardCode'].some(key => value[key])) {
      try { resolveJapanAddress(value); } catch (error) { reject(error.message); }
    }
    if (value.phone && (!/^[+\d\s()（）ー−-]{7,24}$/.test(value.phone.trim()) || value.phone.replace(/\D/g,'').length < 7)) reject('联系电话不正确。');
    if (value.image != null && value.image !== '' && (typeof value.image !== 'string' || !/^\/api\/images\/[a-f0-9-]{36}$/.test(value.image))) reject('门店图片必须先上传。');
  }
  if (command.type === 'setSaleUnits' && (!Array.isArray(command.args[1]) || command.args[1].length > SALE_UNIT_OPTIONS.length)) reject('售卖单位数量不正确。');
  if (command.type === 'setSaleUnitEquations' && (!Array.isArray(command.args[1]) || command.args[1].length > 16)) reject('换算关系数量不正确。');
  if (command.type === 'importProducts') {
    if (!Array.isArray(command.args[0]) || !command.args[0].length || command.args[0].length > 100) reject('每次可导入 1 至 100 个商品。');
    for (const row of command.args[0]) {
      validateCommand(principal, { type: 'addProduct', args: [row], idempotencyKey: command.idempotencyKey });
      if (row.image != null) reject('批量导入暂不支持图片，请通过新增商品上传图片。');
    }
  }
}

function assertOrderAccess(model, principal, id) {
  identifier(id, '订单');
  const order = model.state.orders.find(item => item.id === id);
  if (!order || (principal.role === 'store' && order.storeId !== principal.storeId)) reject('订单不存在。', 404, 'ORDER_NOT_FOUND');
  return order;
}

function assertExpectedQuotes(model, args, expectedQuotes) {
  if (!expectedQuotes) return;
  const [storeId, cart, , , units = {}] = args;
  for (const [productId, qty] of Object.entries(cart)) {
    if (!(Number(qty) > 0)) continue;
    const unit = units[productId] || model.getProduct(productId)?.unit;
    const current = { ...model.getUnitQuote(storeId, productId, unit), unit, perBase: model.getUnitFactor(productId, unit) };
    const expected = expectedQuotes[productId];
    if (!expected || ['unit', 'price', 'taxBasis', 'taxRate', 'perBase'].some(key => own(expected, key) && expected[key] !== current[key])) {
      reject('商品报价或售卖单位已更新，请刷新订货单后确认。', 409, 'QUOTE_CHANGED');
    }
  }
}

function applyCommand(model, principal, command) {
  const args = clone(command.args);
  if(command.type==='applyAttachmentRows') {
    const rows=args[0].map(row=>{
      const quote=row.type==='setUnitQuote',productId=row.args[quote?1:0],unit=row.args[quote?2:1],product=model.getProduct(productId);
      if(!product||product.deletedAt)reject('导入商品不存在或已删除。',404);
      const before=quote?model.getUnitQuote(row.args[0],productId,unit):model.isStockUnlimited(productId)?'无限':model.getWarehouseUnitStock(productId,unit);
      const after=applyCommand(model,principal,row);
      return {productId,productName:product.name,spec:product.spec,unit,kind:quote?'quote':'stock',storeName:quote?model.getStore(row.args[0])?.name:null,before:quote?before.price:before,after:quote?row.args[3]:row.args[2],...(quote?{taxBasis:row.args[4],taxRate:row.args[5]??null}:{})};
    });
    return {name:`${rows.length} 项报价／库存更新`,rows};
  }
  if (['addManualTask', 'updateManualTask', 'setManualTaskDone', 'setManualTaskDueDate', 'deleteManualTask', 'restoreManualTask'].includes(command.type)) {
    // Source and authorship are assigned by the command handler, never by a
    // submitted field or by whether an upstream packing note was typed by hand.
    const todo = model[command.type](...args);
    if (command.type === 'addManualTask') {
      todo.createdBy = principal.userId;
      todo.createdByName = principal.displayName || '';
    }
    todo.updatedBy = principal.userId;
    return todo;
  }
  if (['addStore', 'updateStore'].includes(command.type)) {
    const value = args[command.type === 'updateStore' ? 1 : 0];
    if (command.type === 'addStore' || ['prefectureCode', 'municipalityCode', 'wardCode'].some(key => value[key])) {
      const divisions = resolveJapanAddress(value);
      Object.assign(value, divisions, { city:divisions.municipality,
        address:[divisions.prefecture,divisions.municipality,divisions.ward,(value.addressDetail || '').trim()].filter(Boolean).join('') });
    }
  }
  if (['setStage', 'packLine', 'confirmPackLine', 'setPackLineDone', 'setPackingNote', 'resolvePackingIssue', 'remindOrder', 'recordIssue', 'resolveOrderIssue', 'confirmDelivery'].includes(command.type)) assertOrderAccess(model, principal, args[0]);
  if (command.type === 'submitOrder') {
    assertExpectedQuotes(model, args, command.expectedQuotes);
    if (model.state.orders.filter(order => order.stage !== 'delivered').length >= MAX_ACTIVE_ORDERS) reject('未完成订单已达上限，请联系管理员处理。', 409, 'ACTIVE_ORDER_LIMIT');
    const order = model.submitOrder(...args);
    order.id = `CK-${tokyoToday().replaceAll('-', '')}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    order.date = tokyoToday();
    order.origin = 'cloud';
    order.isDemo = false;
    order.createdBy = principal.userId;
    return order;
  }
  if (command.type === 'addProduct') {
    if (model.state.products.length >= MAX_PRODUCTS) reject('商品数量已达当前上限。', 409, 'CAPACITY_LIMIT');
    const uploaded = typeof args[0].image === 'string' && /^\/api\/images\/[A-Za-z0-9_-]{1,160}$/.test(args[0].image) ? args[0].image : null;
    const product = model.addProduct({ ...args[0], ...(uploaded ? { image: null } : {}) });
    if (uploaded) product.image = uploaded;
    return product;
  }
  if (command.type === 'addStore' && model.state.stores.length >= MAX_STORES) reject('门店数量已达当前上限。', 409, 'CAPACITY_LIMIT');
  if (command.type === 'importProducts') {
    if (model.state.products.length + args[0].length > MAX_PRODUCTS) reject('商品数量已达当前上限。', 409, 'CAPACITY_LIMIT');
    return args[0].map(product => applyCommand(model, principal, { type: 'addProduct', args: [product] }));
  }
  if (command.type === 'confirmDelivery') {
    textField(args[1], '签收人', 120, true);
    const current = assertOrderAccess(model, principal, args[0]);
    if (current.stage === 'delivered') {
      if (current.receivedBy === args[1].trim()) return current;
      reject('订单已签收，不能修改签收人。', 409, 'ALREADY_DELIVERED');
    }
    const order = model.setStage(args[0], 'delivered');
    order.receivedBy = args[1].trim();
    return order;
  }
  return model[command.type](...args);
}

async function requestHash(command) {
  // Canonical key ordering makes network retries independent of JSON key order.
  const canonical = value => value && typeof value === 'object'
    ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json(canonical({ type: command.type, args: command.args, expectedQuotes: command.expectedQuotes || null }))));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

function projectResult(result, principal, type) {
  if (principal.role === 'store' && ['submitOrder', 'confirmDelivery', 'recordIssue'].includes(type)) return safeOrder(result);
  return clone(result ?? null);
}

// Validate against a disposable model using the same constraints as a real write.
export function previewCommand(state, principal, command) {
  principalScope(principal);validateCommand(principal,command);
  try { return applyCommand(modelFor(clone(state)),principal,command); }
  catch(error) { if(error instanceof RepositoryError)throw error;reject(error.message||'操作参数不正确。',error.status===409?409:400); }
}

export async function executeCommand(db, principal, command, {expectedRevision,writeGuard,beforeCommit,commitStatements=[]} = {}) {
  principalScope(principal);
  validateCommand(principal, command);
  const hash = await requestHash(command);
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await db.prepare('SELECT request_hash, result_json, revision, store_id FROM command_idempotency WHERE tenant_id = ? AND user_id = ? AND request_key = ?')
      .bind(principal.tenantId, principal.userId, command.idempotencyKey).first();
    if (prior) {
      if (principal.role === 'store' && prior.store_id !== principal.storeId) reject('无权重放此请求。', 403, 'FORBIDDEN');
      if (prior.request_hash !== hash) reject('同一个请求编号不能用于不同操作。', 409, 'IDEMPOTENCY_CONFLICT');
      await beforeCommit?.();
      const snapshot = await getState(db, principal);
      return { result: projectResult(JSON.parse(prior.result_json), principal, command.type), ...snapshot, replayed: true };
    }
    const { state: previous, revision } = await loadState(db, principal.tenantId);
    if (expectedRevision != null && revision !== expectedRevision) reject('业务资料已更新，请重新查询后再修改。',409,'WRITE_CONFLICT');
    if (principal.role === 'store' && !previous.stores.some(store => store.id === principal.storeId && !store.deletedAt)) reject('门店账号未关联有效门店。', 403, 'STORE_NOT_FOUND');
    const next = clone(previous);
    const model = modelFor(next);
    let result;
    try { result = applyCommand(model, principal, command); }
    catch (error) {
      if (error instanceof RepositoryError) throw error;
      reject(error.message || '操作参数不正确。',error.status===409?409:400);
    }
    next.priceHistory = (next.priceHistory || []).slice(0, MAX_HISTORY);
    next.reminders = (next.reminders || []).slice(0, MAX_HISTORY);
    const guardId = crypto.randomUUID();
    const now = new Date().toISOString();
    const notifications = deriveNotificationEvents(previous, next, {
      eventKey: JSON.stringify([principal.userId, command.idempotencyKey]),
      actorId: principal.userId, actorName: principal.displayName || '', now,
    });
    const coreJson = json(boundedCore(next));
    if (new TextEncoder().encode(coreJson).byteLength > 1500000) reject('公司资料超过当前容量，请联系管理员归档。', 409, 'CAPACITY_LIMIT');
    const statements = [
      // writeGuard is supplied only by trusted server callers, never read from command JSON.
      db.prepare('UPDATE tenants SET core_json = ?, revision = revision + 1 WHERE id = ? AND revision = ?'+(writeGuard?' AND ('+writeGuard.sql+')':''))
        .bind(coreJson, principal.tenantId, revision,...(writeGuard?.params||[])),
      db.prepare('INSERT INTO business_write_assertion (id, ok) VALUES (?, changes())').bind(guardId),
      ...(principal.accountRole ? [db.prepare('INSERT INTO account_audit(id,tenant_id,store_id,actor_id,actor_name,action,target_id,created_at) VALUES(?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),principal.tenantId,principal.storeId||null,principal.userId,principal.displayName,command.type,typeof result?.id==='string'?result.id:null,Math.floor(Date.now()/1000))] : []),
      ...entityStatements(db, principal.tenantId, {
        products: changedRows(previous.products, next.products),
        orders: changedRows(previous.orders, next.orders),
        documents: changedRows(previous.documents, next.documents),
      }),
      ...notificationStatements(db, principal.tenantId, notifications),
      ...(command.type === 'deleteStore' ? [
        db.prepare("UPDATE users SET active = 0 WHERE tenant_id = ? AND store_id = ? AND role = 'store'")
          .bind(principal.tenantId, command.args[0]),
        db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ? AND store_id = ? AND role = 'store')")
          .bind(principal.tenantId, command.args[0]),
        db.prepare("DELETE FROM invites WHERE tenant_id = ? AND store_id = ? AND role = 'store'")
          .bind(principal.tenantId, command.args[0]),
      ] : []),
      db.prepare('INSERT INTO business_audit_log (id, tenant_id, user_id, command, entity_id, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(crypto.randomUUID(), principal.tenantId, principal.userId, command.type, result?.id || (typeof command.args[0] === 'string' ? command.args[0] : null), revision + 1, now),
      db.prepare('INSERT INTO command_idempotency (tenant_id, user_id, store_id, request_key, request_hash, result_json, revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(principal.tenantId, principal.userId, principal.role === 'store' ? principal.storeId : null, command.idempotencyKey, hash, json(result ?? null), revision + 1, now),
      db.prepare('DELETE FROM business_write_assertion WHERE id = ?').bind(guardId),
      ...commitStatements,
    ];
    try {
      await beforeCommit?.();
      await db.batch(statements);
      return { result: projectResult(result, principal, command.type), state: projectState(next, principal), revision: revision + 1, replayed: false };
    } catch (error) {
      if (!/business_revision_conflict|UNIQUE constraint failed: command_idempotency/.test(String(error.message))) throw error;
    }
  }
  reject('其他用户刚刚更新了库存或报价，请重试。', 409, 'WRITE_CONFLICT');
}

export async function seedTenant(db, { tenantId, state, companyName }) {
  identifier(tenantId, '公司');
  plainObject(state, '初始资料');
  const initial = clone(state);
  for (const key of ['products', 'stores', 'orders', 'documents']) if (!Array.isArray(initial[key])) reject('初始资料不完整。');
  if (initial.products.length > MAX_PRODUCTS || initial.stores.length > MAX_STORES || initial.documents.length > MAX_DOCUMENTS) reject('初始资料超过容量上限。');
  // Never make prototype packing/delivery examples into production orders.
  initial.orders = initial.orders.filter(order => !order.isDemo && !String(order.id).startsWith('DEMO-') && !['manual_preview', 'screenshot_example'].includes(order.origin));
  initial.reminders = [];
  // Manual preview work is not part of a new company's initial business data.
  initial.manualTasks = [];
  initial.priceHistory = (initial.priceHistory || []).slice(0, MAX_HISTORY);
  initial.stores = initial.stores.map(({ isDemoAccount, accessCode, ...store }) => store);
  initial.settings ||= {};
  if (companyName) initial.settings.companyName = companyName;
  const name = initial.settings.companyName || '倉流';
  textField(name, '公司名称', 120, true);
  await db.batch([
    db.prepare('INSERT INTO tenants (id, name, core_json, revision) VALUES (?, ?, ?, 0)').bind(tenantId, name, json(boundedCore(initial))),
    db.prepare('INSERT INTO private_materials (tenant_id, data_json) VALUES (?, ?)').bind(tenantId, json(initial.privateMaterials || {})),
    ...entityStatements(db, tenantId, initial),
  ]);
  return { tenantId, products: initial.products.length, stores: initial.stores.length, orders: initial.orders.length, documents: initial.documents.length };
}
