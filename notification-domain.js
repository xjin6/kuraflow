// Shared by the Worker and local preview. Events describe changes; reading an
// event never changes its order, stock level, or outstanding work.
const text = (value, limit = 1000) => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, limit);
const rows = value => Array.isArray(value) ? value : [];
const keyed = value => new Map(rows(value).map(row => [row.id, row]));
const stageNames = { pending: '待配货', packing: '配货中', ready: '待配送', delivering: '配送中', delivered: '已送达' };
const stageRank = { pending: 0, packing: 1, ready: 2, delivering: 3, delivered: 4 };

export function packingLineDone(line) {
  return Number(line?.qty) > 0 && line.packedQty === line.qty && line.packingConfirmed !== false;
}

export function isLegacyShortageNote(note) {
  const value = text(note);
  return /缺货|欠品|不足|缺少|短缺|少\s*\d/.test(value)
    && !/^(?:无|没有|不|不存在)\s*(?:缺货|欠品|不足|缺少|短缺)/.test(value);
}

export function isPackingShortage(line) {
  if (line?.packingIssue && typeof line.packingIssue === 'object') {
    return line.packingIssue.type === 'shortage' && line.packingIssue.status === 'open';
  }
  return !packingLineDone(line) && isLegacyShortageNote(line?.packingNote);
}

export function orderHasOpenIssue(order) {
  return Boolean(order && order.stage !== 'delivered'
    && ((text(order.issue) && !order.issueResolvedAt) || rows(order.items).some(isPackingShortage)));
}

export function notificationStock(state, product) {
  if (!product || product.deletedAt || product.catalogueHidden) return null;
  if(product.stockUnlimited)return null;
  const raw = Object.prototype.hasOwnProperty.call(state?.inventory || {}, product.id)
    ? state.inventory[product.id] : product.stock;
  if (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw))) return null;
  return Number(raw);
}

function savedTime(value, fallback) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

export function deriveNotificationEvents(beforeState, afterState, { eventKey = '', actorName = '', now = new Date().toISOString() } = {}) {
  // Loading an existing database is not an event and must not invent history.
  if (!beforeState || !afterState) return [];
  const beforeOrders = keyed(beforeState.orders), stores = keyed(afterState.stores), products = keyed(afterState.products);
  const at = savedTime(now, new Date().toISOString()), events = [];
  const push = ({ kind, title, body, order, product, createdAt }) => {
    const targetType = order ? 'order' : 'product', targetId = String(order?.id ?? product?.id ?? '');
    events.push({ eventKey: `${eventKey}:${kind}:${encodeURIComponent(targetId)}${order && product ? ':' + encodeURIComponent(product.id) : ''}`,
      kind, title: text(title, 120), body: text(body), targetType, targetId,
      ...(order ? { orderId: order.id } : {}), ...(product ? { productId: product.id } : {}),
      isDemo: Boolean(order?.isDemo || (!order && product?.isDemo)), createdAt: savedTime(createdAt, at), actorName: text(actorName, 120) });
  };
  for (const order of rows(afterState.orders)) {
    const old = beforeOrders.get(order.id), storeName = text(order.storeName || stores.get(order.storeId)?.name || '门店', 120);
    if (!old) push({ kind: 'order_submitted', title: `${storeName}提交了新订单`, body: `订单 ${order.id} · 配送日期 ${order.deliveryDate || order.date || '待确定'}`, order, createdAt: order.submittedAt });
    if (old && old.stage !== order.stage && ['ready', 'delivering', 'delivered'].includes(order.stage)) {
      push({ kind: `order_${order.stage}`, title: `${storeName}的订单${order.stage === 'ready' ? '已完成配货' : order.stage === 'delivering' ? '已开始配送' : '已送达'}`,
        body: `订单 ${order.id}`, order, createdAt: order[`${order.stage === 'ready' ? 'ready' : order.stage === 'delivering' ? 'departed' : 'delivered'}At`] });
    }
    if (order.stage === 'delivered') continue;
    if (text(order.issue) && !order.issueResolvedAt && (!old || old.issueResolvedAt || text(old.issue) !== text(order.issue))) {
      push({ kind: 'order_issue', title: `${storeName}的订单记录了异常`, body: order.issue, order, createdAt: order.issueReportedAt });
    }
    const oldLines = new Map(rows(old?.items).map(line => [line.productId, line]));
    for (const line of rows(order.items)) {
      const previous = oldLines.get(line.productId);
      if (!isPackingShortage(line) || (isPackingShortage(previous) && text(previous?.packingNote) === text(line.packingNote))) continue;
      const currentProduct = products.get(line.productId);
      const product = { ...currentProduct, id:line.productId, name:line.productName || currentProduct?.name || line.productId };
      push({ kind: 'packing_shortage', title: `${storeName}的配货记录了缺货`, body: `${product.name}：${text(line.packingNote) || '待补货'}`,
        order, product, createdAt: line.packingIssue?.updatedAt || line.packingIssue?.reportedAt });
    }
  }
  const reminders = keyed(beforeState.reminders);
  for (const reminder of rows(afterState.reminders)) {
    if (reminders.has(reminder.id)) continue;
    const order = rows(afterState.orders).find(row => row.id === reminder.orderId);
    if (!order) continue;
    const storeName = text(order.storeName || stores.get(order.storeId)?.name || '门店', 120);
    // Several reminders can be saved by an import/command; their IDs distinguish them.
    push({ kind: 'store_reminder', title: `${storeName}催办了订单`, body: `订单 ${order.id}`, order, createdAt: reminder.createdAt });
    events[events.length - 1].eventKey += ':' + encodeURIComponent(reminder.id);
  }
  const oldProducts = keyed(beforeState.products);
  for (const product of products.values()) {
    const stock = notificationStock(afterState, product), oldStock = notificationStock(beforeState, oldProducts.get(product.id));
    if (stock !== null && stock < 6 && (oldStock === null || oldStock >= 6)) {
      push({ kind: 'stock_low', title: `${product.name}库存不足`, body: `当前可订库存 ${stock} ${product.unit || ''}`.trim(), product });
    }
  }
  return events;
}

export function notificationCurrentStatus(event, state) {
  if (event.targetType === 'product') {
    const product = rows(state?.products).find(row => row.id === event.productId || row.id === event.targetId);
    if (!product || product.deletedAt || product.catalogueHidden) return { label: '已归档', resolved: true };
    if(product?.stockUnlimited)return {label:'无限库存',resolved:true};
    const stock = notificationStock(state, product);
    return stock === null ? { label: '库存待确认', resolved: false }
      : stock < 6 ? { label: '待补货', resolved: false } : { label: '库存已恢复', resolved: true };
  }
  const order = rows(state?.orders).find(row => row.id === event.orderId || row.id === event.targetId);
  if (!order) return { label: '已归档', resolved: true };
  if (event.kind === 'packing_shortage') {
    const line = rows(order.items).find(row => row.productId === event.productId);
    return order.stage !== 'delivered' && isPackingShortage(line)
      ? { label: '缺货待处理', resolved: false } : { label: '缺货已处理', resolved: true };
  }
  if (event.kind === 'order_issue') return order.stage !== 'delivered' && text(order.issue) && !order.issueResolvedAt
    ? { label: '异常待处理', resolved: false } : { label: '异常已处理', resolved: true };
  const completedRank = { order_submitted: 2, order_ready: 3, order_delivering: 4, order_delivered: 4, store_reminder: 4 }[event.kind] ?? 4;
  return { label: stageNames[order.stage] || '状态待确认', resolved: (stageRank[order.stage] ?? -1) >= completedRank };
}
