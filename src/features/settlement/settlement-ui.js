import {t, tx, ta, setI18nText} from "../../i18n/index.js";
import { orderMonth, orderSettlement, settlementOrders, settlementSummary, monthlySettlement } from '../../shared/settlement-data.js';

export function createSettlementUI(ctx) {
  const { model, ui, escape:esc, money, button, icon, modal, activeStore, storeAvatar, company } = ctx;
  const stages = {pending:'待配货',packing:'配货中',ready:'待配送',delivering:'配送中',delivered:'已送达'};
  const issuer = () => ({...company,...model.state.settings?.issuer,name:model.state.settings?.companyName || company.name});
  const ownStore = () => ui.role === 'client' ? activeStore().id : ui.settlementStore || '';
  const records = () => settlementOrders(model,{storeId:ownStore(),month:ui.settlementMonth,includeDemo:ui.settlementDemo,query:ui.query}).map(order=>orderSettlement(model,order,issuer()));
  const price = value => value === null ? tx('待确认') : money(value);
  const stateBadge = order => `<span class="status-badge ${esc(order.stage)}">${tx(stages[order.stage] || order.stage)}</span>`;
  function updateURL() {
    if (ui.role !== 'admin') return;
    const params = new URLSearchParams({page:'documents'});
    if (ui.settlementStore) params.set('store',ui.settlementStore);
    if (ui.settlementMonth) params.set('month',ui.settlementMonth);
    if (ui.settlementView === 'monthly') params.set('tab','monthly');
    if (ui.settlementDemo) params.set('demo','1');
    history.replaceState(null,'','?'+params);
  }
  function page() {
    const client = ui.role === 'client', storeId = ownStore();
    const store = model.getStore(storeId);
    const scopedOrders = model.state.orders.filter(order=>(!storeId||order.storeId===storeId) && (ui.settlementDemo || !order.isDemo));
    const months = [...new Set([...scopedOrders.map(orderMonth),...(ui.settlementMonth?[ui.settlementMonth]:[])])].filter(Boolean).sort().reverse();
    const rows = records(), summary = settlementSummary(rows), monthly = ui.settlementView === 'monthly';
    const storeIds = new Set(model.state.orders.map(order=>order.storeId));
    const stores = model.state.stores.filter(s=>!s.deletedAt||storeIds.has(s.id));
    const heading = `<div class="page-heading management-heading"><div class="management-heading-main"><h1>${(client ? tx("我的月结与统计") : tx("月结统计"))}</h1><div class="management-tabs" role="tablist" ${ta("aria-label", "结算分区")}>${[['orders','订单结算'],['monthly','月度统计']].map(([key,label])=>`<button class="management-tab ${ui.settlementView===key?'active':''}" role="tab" aria-selected="${ui.settlementView===key}" data-action="settlement-tab" data-tab="${key}"><strong>${tx(label)}</strong></button>`).join('')}</div></div></div>`;
    const filters = `<div class="settlement-toolbar">${(!client ? `<label class="settlement-filter"><span>${tx("门店")}</span><select class="input" id="settlement-store" ${ta("aria-label", "结算门店")}><option value="">${tx("全部门店")}</option>${stores.map(s=>`<option value="${esc(s.id)}" ${s.id===storeId?'selected':''}>${esc(s.name)}${(s.deletedAt ? tx("（已停用）") : '')}</option>`).join('')}</select></label>` : '')}<label class="settlement-filter"><span>${tx("配送月份")}</span><select class="input" id="settlement-month" ${ta("aria-label", "结算月份")}><option value="">${tx("全部月份")}</option>${months.map(month=>`<option value="${month}" ${month===ui.settlementMonth?'selected':''}>${tx("{0} 月", [month.replace('-',' 年 ')])}</option>`).join('')}</select></label>${(!client&&model.state.orders.some(o=>o.isDemo) ? `<label class="settlement-demo"><input id="settlement-demo" type="checkbox" ${ui.settlementDemo?'checked':''}>${tx("含演示订单")}</label>` : '')}</div>`;
    const stats = `<div class="stat-grid settlement-metrics">${ctx.statCard('订单数',`${summary.count}<small>${tx("笔")}</small>`,'','clipboard')}${ctx.statCard('已送达',`${summary.delivered}<small>${tx("笔")}</small>`,'','truck')}${ctx.statCard('货品金额',money(summary.amount),summary.unpriced?`${summary.unpriced} 项单价待确认`:'按订单保存单价','wallet')}${ctx.statCard('已送达金额',money(summary.deliveredAmount),'不含运费','check')}</div>`;
    const context = store ? `<div class="settlement-store-context">${storeAvatar(store)}<div><strong>${esc(store.name)}</strong><span>${esc((store.address || t("配送地址待填写")))}</span></div></div>` : '';
    const archive = (model.state.documents || []).filter(doc=>(!storeId||doc.storeId===storeId));
    return heading + filters + stats + `<section class="section-card settlement-card">${context}<div class="section-header"><h2 class="section-title">${(monthly ? tx("月度汇总") : tx("订单明细"))}</h2><span class="settlement-result-count">${(monthly ? monthlySettlement(rows).length+' 条汇总' : rows.length+' 笔订单')}</span></div>${(!rows.length ? ctx.emptyState('暂无订单',storeId?'此门店在所选月份暂无订单。':'选择其他月份或门店查看。','clipboard') : (monthly ? monthlyTable(rows) : orderTable(rows)))}</section>${(archive.length ? `<details class="settlement-archive"><summary>${tx("历史单据")} <span>${archive.length}</span></summary><div>${archive.map(doc=>`<button class="text-button" data-action="document-detail" data-id="${esc(doc.id)}">${esc(doc.customer)} · ${esc((doc.period || doc.date))} ${esc(doc.title)} ${icon('arrow')}</button>`).join('')}</div></details>` : '')}`;
  }
  function orderTable(rows) {
    return `<div class="table-scroll" tabindex="0"><div class="table-scroll-hint">${tx("↔ 左右滑动查看全部列")}</div><table class="settlement-table"><thead><tr><th>${tx("订单 / 门店")}</th><th>${tx("配送日期")}</th><th>${tx("状态")}</th><th>${tx("商品")}</th><th class="align-right">${tx("货品金额")}</th><th class="align-right">${tx("含税金额")}</th><th class="align-right">${tx("单据")}</th></tr></thead><tbody>${rows.map(record=>`<tr><td><button class="product-name-link" data-action="settlement-detail" data-id="${esc(record.id)}">${esc(record.id)}</button><span class="cell-secondary">${esc(record.store.name)}${(record.order.isDemo ? tx(" · 演示") : '')}</span></td><td>${esc(record.order.deliveryDate)}</td><td>${stateBadge(record.order)}</td><td>${tx("{0} 种", [record.lines.length])}</td><td class="align-right settlement-money">${money(record.amount)}${(record.unpriced ? `<span class="cell-secondary">${tx("{0} 项待确认", [record.unpriced])}</span>` : '')}</td><td class="align-right settlement-money">${price(record.gross)}</td><td class="settlement-actions">${button(tx("明细"),'settlement-detail','ghost',`data-id="${esc(record.id)}"`)}${button('PDF','order-pdf','secondary',`data-id="${esc(record.id)}" aria-label="导出${esc(record.id)} PDF"`,'download')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function monthlyTable(rows) {
    return `<div class="table-scroll" tabindex="0"><div class="table-scroll-hint">${tx("↔ 左右滑动查看全部列")}</div><table class="settlement-table"><thead><tr><th>${tx("门店")}</th><th>${tx("月份")}</th><th>${tx("订单")}</th><th>${tx("已送达")}</th><th class="align-right">${tx("货品金额")}</th><th class="align-right">${tx("含税金额")}</th><th></th></tr></thead><tbody>${monthlySettlement(rows).map(group=>`<tr><td><strong>${esc(group.store.name)}</strong></td><td>${group.month}</td><td>${tx("{0} 笔", [group.count])}</td><td>${tx("{0} 笔", [group.delivered])}</td><td class="align-right settlement-money">${money(group.amount)}${(group.unpriced ? `<span class="cell-secondary">${tx("{0} 项待确认", [group.unpriced])}</span>` : '')}</td><td class="align-right settlement-money">${price(group.gross)}</td><td class="align-right">${button(tx("查看订单"),'settlement-drilldown','ghost',`data-store="${esc(group.store.id)}" data-month="${group.month}"`,'arrow')}</td></tr>`).join('')}</tbody></table></div>`;
  }
  function recordFor(id) {
    const order = model.state.orders.find(order=>order.id===id);
    if (!order || (ui.role === 'client' && order.storeId !== activeStore().id)) throw new Error('无法查看该订单。');
    return orderSettlement(model,order,issuer());
  }
  function showDetail(id) {
    const record=recordFor(id), {order,store,lines}=record;
    modal(tx("订单结算"),`<div class="document-detail settlement-detail"><div class="settlement-detail-header"><div><h3>${esc(store.name)}</h3><p>${esc((store.address || t("地址待填写")))}</p><p>${esc([store.contact,store.phone].filter(Boolean).join(' · '))}</p></div><div>${stateBadge(order)}<p>${esc(record.id)}</p><p>${tx("配送日期 {0}", [esc(order.deliveryDate)])}</p></div></div><div class="table-scroll"><table><thead><tr><th>${tx("商品 / 规格")}</th><th class="align-right">${tx("数量")}</th><th>${tx("单位")}</th><th class="align-right">${tx("单价")}</th><th class="align-right">${tx("金额")}</th></tr></thead><tbody>${lines.map(line=>`<tr><td>${esc(line.name)}<span class="cell-secondary">${esc(line.spec)}</span></td><td class="align-right">${line.qty}</td><td>${tx(line.unit)}</td><td class="align-right">${price(line.price)}</td><td class="align-right">${price(line.total)}</td></tr>`).join('')}</tbody></table></div><dl class="settlement-totals"><div><dt>${(record.unpriced ? tx("已知货品金额") : tx("货品金额"))}</dt><dd>${money(record.amount)}</dd></div><div><dt>${tx("税额")}</dt><dd>${price(record.tax)}</dd></div><div><dt>${tx("含税货品金额")}</dt><dd>${price(record.gross)}</dd></div><div><dt>${tx("运费")}</dt><dd>${(record.shipping===null ? tx("未录入") : money(record.shipping))}</dd></div></dl>${(record.unpriced||record.taxUnknown ? `<p class="settlement-note">${(record.unpriced ? tx("{0} 项单价待确认。", [record.unpriced]) : '')}${(record.taxUnknown ? tx("税口径未确认的项目未计入含税合计。") : '')}</p>` : '')}</div>`,button(tx("关闭"),'close','secondary')+button(tx("导出 PDF"),'order-pdf','primary',`data-id="${esc(id)}"`,'download'));
  }
  async function exportPDF(id, el) {
    const record=recordFor(id), original=el.innerHTML;
    el.disabled=true; setI18nText(el, () => t("生成中…"), "textContent");
    try {
      const {createOrderPDF}=await import('./order-pdf.js');
      if(ctx.getDocumentProfile)record.issuer=(await ctx.getDocumentProfile()).issuer;
      const bytes=await createOrderPDF(record);
      ctx.download(`${record.store.name}_${record.order.deliveryDate}_${record.id}_纳品书.pdf`.replace(/[\\/:*?"<>|]/g,'_'),bytes,'application/pdf');
      ctx.toast('PDF 已导出。');
    } finally { if(el.isConnected){el.disabled=false;el.innerHTML=original;} }
  }
  async function handleAction(action,el) {
    if(action==='store-settlement') {
      if(ui.role!=='admin')throw new Error('仅管理员可访问门店结算。');
      ui.settlementStore=el.dataset.id;ui.settlementMonth='';ui.settlementView='orders';ui.settlementDemo=el.dataset.demo==='1';
      ctx.nav('documents','store-settlement');updateURL();return true;
    }
    if(action==='settlement-tab') {ui.settlementView=el.dataset.tab==='monthly'?'monthly':'orders';updateURL();ctx.render();return true;}
    if(action==='settlement-drilldown') {if(ui.role==='client'&&el.dataset.store!==activeStore().id)throw new Error('无权查看。');ui.settlementStore=el.dataset.store;ui.settlementMonth=el.dataset.month;ui.settlementView='orders';updateURL();ctx.render();return true;}
    if(action==='settlement-detail') {showDetail(el.dataset.id);return true;}
    if(action==='order-pdf') {await exportPDF(el.dataset.id,el);return true;}
    return false;
  }
  function handleChange(input) {
    if(!['settlement-store','settlement-month','settlement-demo'].includes(input.id))return false;
    if(input.id==='settlement-store') {if(ui.role!=='admin')throw new Error('无权切换门店。');ui.settlementStore=input.value;}
    if(input.id==='settlement-month')ui.settlementMonth=input.value;
    if(input.id==='settlement-demo')ui.settlementDemo=input.checked;
    updateURL();ctx.render();return true;
  }
  return {page,handleAction,handleChange};
}
