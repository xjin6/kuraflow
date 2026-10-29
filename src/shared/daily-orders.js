import {orderSettlement,roundAmount} from './settlement-data.js';

const stages=['pending','packing','ready','delivering','delivered'];
const sumQuantity=values=>Number(values.reduce((sum,n)=>sum+Number(n||0),0).toPrecision(15));
const sumMoney=(rows,key)=>rows.some(row=>row[key]===null)?null:roundAmount(rows.reduce((sum,row)=>sum+row[key],0));
const quantityKey=line=>JSON.stringify([line.productId,line.name,line.spec,line.unit]);
const priceKey=line=>JSON.stringify([line.price,line.taxBasis,line.taxRate,line.perBase]);
const knownDate=value=>{
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return '';
  const parsed=new Date(value+'T00:00:00Z');
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value?value:'';
};
export const deliveryDay=order=>knownDate(order.deliveryDate);
export const dailyOrderKey=order=>JSON.stringify([order.storeId,deliveryDay(order)||'unknown:'+order.id,Boolean(order.isDemo)]);

/** A read-only view over saved orders. Never creates or replaces a business order. */
export function dailyOrderSummary(model,orders,issuer={}) {
  if(!orders.length)throw new Error('没有可合并的订单。');
  const key=dailyOrderKey(orders[0]);
  if(orders.some(order=>dailyOrderKey(order)!==key))throw new Error('只能汇总同一门店、同一配送日的订单。');
  const unique=[...new Map(orders.map(order=>[order.id,order])).values()]
    .sort((a,b)=>String(a.submittedAt||a.date||'').localeCompare(String(b.submittedAt||b.date||''))||a.id.localeCompare(b.id));
  const records=unique.map(order=>orderSettlement(model,order,issuer));
  const rawLines=records.flatMap(record=>record.lines.map((line,index)=>({...line,
    perBase:record.order.items[index].perBase??null,
    sourceOrderId:record.id,sourceStage:record.order.stage,
  })));
  const priceGroups=new Map();
  for(const line of rawLines){const k=quantityKey(line)+priceKey(line);if(!priceGroups.has(k))priceGroups.set(k,[]);priceGroups.get(k).push(line);}
  const lines=[];
  for(const sources of priceGroups.values()){
    const first=sources[0],qty=sumQuantity(sources.map(line=>line.qty));
    const totals=Object.fromEntries(['total','net','tax','gross'].map(field=>[field,sumMoney(sources,field)]));
    const recalculated=orderSettlement(model,{...unique[0],items:[{...first,productName:first.name,qty}]}).lines[0];
    // Keep original rows when combining would change even one cent of the
    // saved per-order arithmetic. No averaging or re-taxing historical prices.
    if(['total','net','tax','gross'].some(field=>recalculated[field]!==totals[field]))lines.push(...sources.map(line=>({...line,sourceOrderIds:[line.sourceOrderId]})));
    else lines.push({...first,...totals,qty,packedQty:sumQuantity(sources.map(line=>line.packedQty)),sourceOrderIds:sources.map(line=>line.sourceOrderId)});
  }
  const summaryGroups=new Map();
  for(const line of rawLines){const k=quantityKey(line);if(!summaryGroups.has(k))summaryGroups.set(k,[]);summaryGroups.get(k).push(line);}
  const summaryLines=[...summaryGroups.values()].map(sources=>{
    const first=sources[0],rates=new Map();
    for(const line of sources){const k=priceKey(line);if(!rates.has(k))rates.set(k,[]);rates.get(k).push(line);}
    return {...first,qty:sumQuantity(sources.map(line=>line.qty)),packedQty:sumQuantity(sources.map(line=>Math.min(line.qty,line.packedQty))),
      total:sumMoney(sources,'total'),knownAmount:roundAmount(sources.reduce((sum,line)=>sum+(line.total??0),0)),
      prices:[...rates.values()].map(rows=>({...rows[0],qty:sumQuantity(rows.map(line=>line.qty)),total:sumMoney(rows,'total'),sourceOrderIds:rows.map(line=>line.sourceOrderId)})),
      sourceOrderIds:[...new Set(sources.map(line=>line.sourceOrderId))]};
  });
  const productOrder=new Map([...summaryGroups.keys()].map((key,index)=>[key,index]));
  lines.sort((a,b)=>productOrder.get(quantityKey(a))-productOrder.get(quantityKey(b)));
  const day=deliveryDay(unique[0]),taxUnknown=records.reduce((n,r)=>n+r.taxUnknown,0);
  const allDelivered=unique.every(order=>order.stage==='delivered');
  const taxGroups=[...new Set(records.flatMap(record=>record.taxGroups.map(row=>row.rate)))].sort((a,b)=>a-b).map(rate=>({rate,
    net:roundAmount(records.reduce((sum,record)=>sum+(record.taxGroups.find(row=>row.rate===rate)?.net||0),0)),
    tax:roundAmount(records.reduce((sum,record)=>sum+(record.taxGroups.find(row=>row.rate===rate)?.tax||0),0))}));
  return {key,id:'daily:'+unique[0].storeId+':'+(day||unique[0].id),day,store:{...records[0].store},issuer:{...issuer},
    order:{id:'daily:'+unique[0].storeId+':'+day,storeId:unique[0].storeId,deliveryDate:day,stage:allDelivered?'delivered':'pending',isDemo:Boolean(unique[0].isDemo),note:unique.filter(order=>order.note).map(order=>order.id+'：'+order.note).join('；')},
    aggregation:{kind:'store-day',day,orderIds:unique.map(order=>order.id),count:unique.length},orders:unique,records,
    lines:lines.map((line,index)=>({...line,index:index+1})),summaryLines,productCount:new Set(rawLines.map(line=>line.productId)).size,
    statuses:stages.map(stage=>({stage,count:unique.filter(order=>order.stage===stage).length})).filter(row=>row.count),
    unpriced:records.reduce((n,r)=>n+r.unpriced,0),taxUnknown,
    amount:roundAmount(records.reduce((sum,r)=>sum+r.amount,0)),net:sumMoney(records,'net'),tax:sumMoney(records,'tax'),gross:sumMoney(records,'gross'),
    shipping:sumMoney(records,'shipping'),shippingTax:sumMoney(records,'shippingTax'),
    knownShipping:roundAmount(records.reduce((sum,r)=>sum+(r.shipping??0),0)),taxGroups};
}

export function groupDailyOrders(model,orders,issuer={}) {
  const groups=new Map();
  for(const order of orders){const key=dailyOrderKey(order);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(order);}
  return [...groups.values()].map(rows=>dailyOrderSummary(model,rows,issuer))
    .sort((a,b)=>b.day.localeCompare(a.day)||a.store.name.localeCompare(b.store.name,'zh-CN')||a.key.localeCompare(b.key));
}

export function filterDailyOrders(groups,{status='all',query=''}={}) {
  const word=query.trim().toLocaleLowerCase();
  // Match a group without truncating its members; totals always cover the day.
  return groups.filter(group=>(status==='all'||group.orders.some(order=>order.stage===status))
    &&(!word||[group.store.name,group.day,...group.orders.map(order=>order.id)].some(value=>String(value).toLocaleLowerCase().includes(word))));
}
