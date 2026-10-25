// Settlement views are computed from saved orders, never from the reference PDFs.
export const roundAmount = value => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const amount = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
export const orderMonth = order => String(order.deliveryDate || order.date || order.submittedAt || '').slice(0, 7);
export const tokyoDate = () => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Tokyo', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());

export function orderSettlement(model, order, issuer = {}) {
  const store = model.getStore(order.storeId) || { id:order.storeId, name:order.storeName || '门店信息未记录' };
  const lines = order.items.map((line, index) => {
    const product = model.getProduct(line.productId) || {};
    const qty = Number(line.qty || 0), price = amount(line.price) ? Number(line.price) : null;
    const total = price === null ? null : roundAmount(qty * price);
    const taxKnown = price !== null && ['inclusive','exclusive'].includes(line.taxBasis) && amount(line.taxRate) && Number(line.taxRate) >= 0;
    const rate = taxKnown ? Number(line.taxRate) : null;
    const tax = !taxKnown ? null : roundAmount(line.taxBasis === 'inclusive' ? total - total / (1 + rate) : total * rate);
    return { index:index + 1, productId:line.productId, name:line.productName || product.name || line.productId,
      spec:line.spec || product.spec || '', unit:line.unit || product.unit || '', qty, packedQty:Number(line.packedQty || 0), price, total,
      taxBasis:line.taxBasis || 'unspecified', taxRate:rate, tax,
      net:taxKnown ? roundAmount(line.taxBasis === 'inclusive' ? total - tax : total) : null,
      gross:taxKnown ? roundAmount(line.taxBasis === 'exclusive' ? total + tax : total) : null };
  });
  const unpriced = lines.filter(line => line.price === null).length;
  const taxUnknown = lines.filter(line => line.tax === null).length;
  const sum = key => roundAmount(lines.reduce((total, line) => total + (line[key] ?? 0), 0));
  const shipping = amount(order.shipping) ? Number(order.shipping) : null;
  const shippingTax = amount(order.shippingTax) ? Number(order.shippingTax) : null;
  return { id:order.id, order, store:{...store}, issuer:{...issuer}, lines, unpriced, taxUnknown,
    amount:sum('total'), net:taxUnknown ? null : sum('net'), tax:taxUnknown ? null : sum('tax'),
    gross:taxUnknown ? null : sum('gross'), shipping, shippingTax,
    taxGroups:[...new Set(lines.filter(line => line.tax !== null).map(line => line.taxRate))].sort((a,b)=>a-b).map(rate => ({
      rate, net:roundAmount(lines.filter(line => line.taxRate === rate).reduce((total,line)=>total+line.net,0)),
      tax:roundAmount(lines.filter(line => line.taxRate === rate).reduce((total,line)=>total+line.tax,0))
    })) };
}

export function settlementOrders(model, { storeId = '', month = '', includeDemo = false, query = '' } = {}) {
  const keyword = query.trim().toLowerCase();
  return model.state.orders.filter(order => (!storeId || order.storeId === storeId)
    && (!month || orderMonth(order) === month) && (includeDemo || !order.isDemo)
    && (!keyword || [order.id, model.getStore(order.storeId)?.name].join(' ').toLowerCase().includes(keyword)))
    .slice().sort((a,b)=>String(b.deliveryDate).localeCompare(String(a.deliveryDate)) || String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
}

export function settlementSummary(records) {
  return { count:records.length, delivered:records.filter(r=>r.order.stage === 'delivered').length,
    amount:roundAmount(records.reduce((sum,r)=>sum+r.amount,0)),
    deliveredAmount:roundAmount(records.filter(r=>r.order.stage==='delivered').reduce((sum,r)=>sum+r.amount,0)),
    unpriced:records.reduce((sum,r)=>sum+r.unpriced,0), taxUnknown:records.reduce((sum,r)=>sum+r.taxUnknown,0),
    tax:records.some(r=>r.tax===null) ? null : roundAmount(records.reduce((sum,r)=>sum+r.tax,0)),
    gross:records.some(r=>r.gross===null) ? null : roundAmount(records.reduce((sum,r)=>sum+r.gross,0)) };
}

export function monthlySettlement(records) {
  const groups = new Map();
  for (const record of records) {
    const month = orderMonth(record.order), key = record.store.id + ':' + month;
    if (!groups.has(key)) groups.set(key, { month, store:record.store, records:[] });
    groups.get(key).records.push(record);
  }
  return [...groups.values()].map(group=>({...group,...settlementSummary(group.records)}))
    .sort((a,b)=>b.month.localeCompare(a.month) || a.store.name.localeCompare(b.store.name, 'zh-CN'));
}
