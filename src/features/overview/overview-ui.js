import {businessRange,businessAnalytics} from '../../shared/overview-data.js';
import {tokyoDate} from '../../shared/settlement-data.js';

export function createOverviewUI(ctx) {
  const {model,ui,escape:esc,money,icon,button,render,nav,modal,emptyState,closeOverlay=()=>{},toast=()=>{}}=ctx;
  const now=()=>tokyoDate();
  const scope=()=>({includeDemo:ui.businessDemo});
  const range=()=>{try{return businessRange(ui.businessRange,ui.businessStart,ui.businessEnd,now());}catch{ui.businessRange='month';return businessRange('month','','',now());}};
  function saveURL() {
    const params=new URLSearchParams({page:'overview',range:ui.businessRange});
    params.set('demo',ui.businessDemo?'1':'0');
    if(ui.businessRange==='custom'){params.set('from',ui.businessStart);params.set('to',ui.businessEnd);}
    history.replaceState(null,'','?'+params);
  }
  const shortDate=date=>date.slice(5).replace('-','/');
  function comparison(value,previous,unknown=false) {
    if(unknown||value===null||previous===null)return '<span class="business-comparison">金额待确认</span>';
    if(previous===0)return `<span class="business-comparison">${value===0?'上一周期暂无成交':'上一周期为 0'}</span>`;
    const change=Math.round((value-previous)/previous*1000)/10;
    return `<span class="business-comparison ${change>0?'up':change<0?'down':''}">${change===0?'与上一周期持平':`${change>0?'+':''}${change}% <span>较上一周期</span>`}</span>`;
  }
  function metric(label,value,change,ico,unknown=false) {
    return `<article class="business-metric"><div class="business-metric-label">${label}${icon(ico)}</div><strong class="business-metric-value ${unknown?'is-unknown':''}">${value}</strong>${change}</article>`;
  }
  function page() {
    const selected=range(),analytics=businessAnalytics(model,selected,scope()),current=analytics.current,previous=analytics.previous;
    const periods=[['week','本周'],['month','本月'],['custom','自选日期']];
    const heading=`<div class="page-heading business-heading"><div class="heading-copy"><h1>经营概览</h1></div><div class="tabs business-periods" role="tablist" aria-label="经营统计周期">${periods.map(([key,label])=>`<button class="tab ${ui.businessRange===key?'active':''}" role="tab" aria-selected="${ui.businessRange===key}" data-action="business-range" data-range="${key}">${label}</button>`).join('')}</div></div>`;
    const dates=ui.businessRange==='custom'?`<div class="business-custom-range"><label><span>开始日期</span><input class="input" type="date" id="business-from" aria-label="经营统计开始日期" value="${selected.start}" max="${now()}" required></label><span class="business-date-separator">至</span><label><span>结束日期</span><input class="input" type="date" id="business-to" aria-label="经营统计结束日期" value="${selected.end}" max="${now()}" required></label>${button('应用','business-apply-range','secondary')}</div>`:'';
    const scopeBar=`<div class="business-scope"><div class="business-order-counts"><button class="text-button" data-action="business-orders">期间订单 <strong>${analytics.orders.length}</strong> 笔 ${icon('arrow')}</button><span>已送达 ${current.count} · 未完成 ${analytics.orders.filter(order=>['pending','packing','ready','delivering'].includes(order.stage)).length}</span></div>${model.state.orders.some(order=>order.isDemo)?`<label class="business-demo"><input id="business-demo" type="checkbox" ${ui.businessDemo?'checked':''}>含演示订单</label>`:''}</div>`;
    const metrics=`<div class="business-period-caption"><span>${selected.start.replaceAll('-','/')} - ${selected.end.replaceAll('-','/')}<span class="business-compare-period">对比 ${shortDate(selected.previousStart)} - ${shortDate(selected.previousEnd)}</span></span><span>已送达订单 · 按配送日期 · 不含运费</span></div><section class="business-metrics" aria-label="经营指标">${metric('已送达货品金额',money(current.amount),comparison(current.amount,previous.amount,current.missing||previous.missing),'wallet')}${metric('已完成订单数',`${current.count}<small>笔</small>`,comparison(current.count,previous.count),'clipboard')}${metric('有成交门店数',`${current.stores}<small>家</small>`,comparison(current.stores,previous.stores),'store')}${metric('平均订单金额',!current.count?'—':current.average===null?'待确认':money(current.average),!current.count?'<span class="business-comparison">暂无已完成订单</span>':!previous.count?'<span class="business-comparison">上一周期暂无成交</span>':comparison(current.average,previous.average),'tag',current.average===null)}</section>${current.missing?`<p class="business-data-note">${icon('alert')}${current.missing} 项单价待确认，金额仅含已知部分，平均订单金额暂不计算。</p>`:''}`;
    return `<div class="business-overview">${heading}${dates}${scopeBar}${metrics}${trend(analytics)}<div class="business-rankings">${storeTable(analytics)}${productTable(analytics)}</div></div>`;
  }
  function trend(analytics) {
    const quantity=ui.businessMetric==='count',buckets=analytics.buckets,values=buckets.map(row=>quantity?row.count:row.amount),max=Math.max(...values,0);
    const magnitude=10**Math.floor(Math.log10(max||1));
    const ceiling=quantity?Math.max(4,Math.ceil(max/4)*4):max?([1,2,2.5,5,10].find(step=>step*magnitude>=max)||10)*magnitude:100;
    const y=value=>100-value/ceiling*100;
    const points=buckets.map((row,index)=>({row,x:buckets.length===1?50:index/(buckets.length-1)*100,y:y(values[index])}));
    const path=points.map((point,index)=>`${index?'L':'M'}${point.x*10},${point.y*2}`).join(' ');
    const tick=value=>quantity?String(value):value>=10000?'¥'+Number((value/10000).toFixed(2))+'万':value>=1000?'¥'+Number((value/1000).toFixed(2))+'千':'¥'+Number(value.toFixed(2));
    const xIndices=[...new Set([0,Math.floor((buckets.length-1)/2),buckets.length-1])];
    const content=analytics.current.count?`<div class="business-chart"><div class="business-chart-plot">${[0,1,2,3,4].map(index=>`<div class="business-chart-grid" style="top:${index*25}%" aria-hidden="true"><span>${tick(ceiling*(1-index/4))}</span></div>`).join('')}<svg class="business-chart-svg" viewBox="0 0 1000 200" preserveAspectRatio="none" role="img" aria-label="所选期间${quantity?'已完成订单数':'已送达货品金额'}趋势"><path d="${path} L${points.at(-1).x*10},200 L${points[0].x*10},200 Z" fill="rgba(72,104,132,.10)"/><path d="${path}" fill="none" stroke="#52718a" stroke-width="2.3" vector-effect="non-scaling-stroke"/></svg>${points.map(({row,x,y},index)=>`<button type="button" class="business-chart-hit ${x<=25?'is-first':x>=75?'is-last':''} ${points.length===1?'is-only':''}" style="left:${x}%;width:${Math.max(1,100/points.length)}%;--dot-top:${y}%" tabindex="${index===points.length-1?0:-1}" aria-label="${esc(row.start)}${row.end!==row.start?' 至 '+esc(row.end):''}，${row.count} 笔订单，货品金额 ${esc(money(row.amount))}${row.missing?'，含待确认单价':''}"><span class="business-chart-guide"></span><span class="business-chart-dot"></span><span class="business-chart-tooltip" aria-hidden="true"><strong>${shortDate(row.start)}${row.end!==row.start?' - '+shortDate(row.end):''}</strong><span>${money(row.amount)}</span><small>${row.count} 笔订单${row.missing?' · 金额待补全':''}</small></span></button>`).join('')}</div><div class="business-chart-axis ${buckets.length===1?'is-single':''}" aria-hidden="true">${xIndices.map(index=>`<span>${shortDate(buckets[index].start)}</span>`).join('')}</div></div>`:`<div class="business-chart-empty">${icon('grid')}<strong>所选期间暂无已送达订单</strong><span>完成配送后，成交趋势会在这里显示。</span></div>`;
    return `<section class="section-card business-trend"><div class="section-header"><div><h2 class="section-title">成交趋势</h2><p>${{day:'按日',week:'按周',month:'按月'}[analytics.step]}汇总</p></div><div class="tabs business-chart-switch" role="tablist" aria-label="趋势指标">${[['amount','金额'],['count','单量']].map(([key,label])=>`<button class="tab ${ui.businessMetric===key?'active':''}" role="tab" aria-selected="${ui.businessMetric===key}" data-action="business-metric" data-metric="${key}">${label}</button>`).join('')}</div></div>${content}</section>`;
  }
  function storeTable(analytics) {
    const rows=analytics.stores.slice(0,5);
    return `<section class="section-card business-ranking"><div class="section-header"><div><h2 class="section-title">门店表现</h2><p>与上一周期对比</p></div><button class="text-button" data-page="stores">全部门店 ${icon('arrow')}</button></div>${!rows.length?emptyState('暂无门店成交','所选期间及上一周期暂无已送达订单。','store'):`<div class="table-scroll" tabindex="0"><div class="table-scroll-hint">↔ 左右滑动查看全部列</div><table><thead><tr><th>门店</th><th class="align-right">货品金额</th><th class="align-right">已完成</th><th class="align-right">最近下单</th></tr></thead><tbody>${rows.map(row=>`<tr><td><button class="product-name-link" data-action="store-settlement" data-id="${esc(row.store.id)}" data-demo="${ui.businessDemo?'1':'0'}">${esc(row.store.name)}</button>${row.store.deletedAt?'<span class="cell-secondary">已停用</span>':''}</td><td class="align-right business-numeric">${money(row.amount)}${comparison(row.amount,row.previousAmount,row.missing||row.previousMissing)}</td><td class="align-right business-numeric">${row.count}</td><td class="align-right business-last-order">${row.lastOrder?esc(row.lastOrder):'—'}</td></tr>`).join('')}</tbody></table></div>`}</section>`;
  }
  function productTable(analytics) {
    const rows=analytics.products.slice(0,5);
    return `<section class="section-card business-ranking"><div class="section-header"><div><h2 class="section-title">商品排行</h2><p>按已送达货品金额</p></div><button class="text-button" data-page="catalogue">全部商品 ${icon('arrow')}</button></div>${!rows.length?emptyState('暂无商品成交','完成配送后显示商品销售情况。','box'):`<div class="table-scroll" tabindex="0"><div class="table-scroll-hint">↔ 左右滑动查看全部列</div><table><thead><tr><th>商品</th><th class="align-right">数量</th><th class="align-right">货品金额</th></tr></thead><tbody>${rows.map((row,index)=>`<tr><td><div class="business-product-name"><span class="business-rank">${String(index+1).padStart(2,'0')}</span><div><button class="product-name-link" data-action="price-info" data-id="${esc(row.product.id)}">${esc(row.product.name)}</button><span class="cell-secondary">${row.count} 笔订单</span></div></div></td><td class="align-right business-quantities">${row.quantities.map(q=>`<span>${q.qty} ${esc(q.unit)}</span>`).join('')}</td><td class="align-right business-numeric">${money(row.amount)}${row.missing?'<span class="cell-secondary">部分单价待确认</span>':''}</td></tr>`).join('')}</tbody></table></div>`}</section>`;
  }
  function orderList(title,orders) {
    const stages={pending:'待配货',packing:'配货中',ready:'待配送',delivering:'配送中',delivered:'已送达'};
    modal(title,`<div class="notification-list">${orders.map(order=>`<div class="notification-row"><div><strong>${esc(model.getStore(order.storeId)?.name || order.storeId)}</strong><p>${esc(order.id)}${order.isDemo?' · 演示':''} · ${esc(order.deliveryDate)} · ${stages[order.stage]||esc(order.stage)}${order.issue?' · '+esc(order.issue):''}</p></div>${button('查看','order-detail','secondary',`data-id="${esc(order.id)}"`,'arrow')}</div>`).join('')||emptyState('暂无订单','','clipboard')}</div>`,button('关闭','close','secondary'));
  }
  function handleChange(input) {
    if(input.id!=='business-demo')return false;
    if(ui.role!=='admin')throw new Error('仅管理员可查看经营数据。');
    ui.businessDemo=input.checked;saveURL();render();
    document.getElementById('business-demo')?.focus({preventScroll:true});
    return true;
  }
  function handleAction(action,el) {
    if(!['business-range','business-apply-range','business-metric','business-orders'].includes(action))return false;
    if(ui.role!=='admin')throw new Error('仅管理员可查看经营数据。');
    if(action==='business-range') {
      const previous=range(),next=el.dataset.range;
      ui.businessRange=['week','month','custom'].includes(next)?next:'month';
      if(next==='custom'){ui.businessStart=previous.start;ui.businessEnd=previous.end;}
      saveURL();render();
    } else if(action==='business-apply-range') {
      const start=document.querySelector('#business-from').value,end=document.querySelector('#business-to').value;
      businessRange('custom',start,end,now());ui.businessStart=start;ui.businessEnd=end;ui.businessRange='custom';saveURL();render();
    } else if(action==='business-metric') {ui.businessMetric=el.dataset.metric==='count'?'count':'amount';render();}
    else if(action==='business-orders') orderList('期间订单',businessAnalytics(model,range(),scope()).orders);
    return true;
  }
  function handleKeydown(event) {
    const hit=event.target.closest?.('.business-chart-hit');if(!hit||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const hits=[...hit.parentElement.querySelectorAll('.business-chart-hit')],index=hits.indexOf(hit);
    const next=event.key==='Home'?0:event.key==='End'?hits.length-1:Math.max(0,Math.min(hits.length-1,index+(event.key==='ArrowRight'?1:-1)));
    hits.forEach((node,i)=>node.tabIndex=i===next?0:-1);hits[next].focus({preventScroll:true});
  }
  return {page,handleAction,handleChange,handleKeydown,saveURL};
}
