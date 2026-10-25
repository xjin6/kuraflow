import { roundAmount, tokyoDate } from './settlement-data.js';
import { isPackingShortage, orderHasOpenIssue } from './notification-domain.js';

const DAY=86400000;
const tokyoDayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'});
export function validDay(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(value+'T12:00:00Z'))
    && new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
}
export function shiftDay(day,offset) { return new Date(Date.parse(day+'T12:00:00Z')+offset*DAY).toISOString().slice(0,10); }
export function businessRange(preset='month',start='',end='',today=tokyoDate()) {
  if(preset==='week')start=shiftDay(today,-((new Date(today+'T12:00:00Z').getUTCDay()+6)%7));
  else if(preset!=='custom')start=today.slice(0,7)+'-01';
  if(preset!=='custom')end=today;
  if(!validDay(start)||!validDay(end)||start>end)throw new Error('请选择有效的起止日期。');
  if(end>today)throw new Error('结束日期不能晚于今天。');
  const days=Math.round((Date.parse(end)-Date.parse(start))/DAY)+1;
  if(days>366)throw new Error('一次最多查看 366 天，请缩短日期范围。');
  return {start,end,days,previousStart:shiftDay(start,-days),previousEnd:shiftDay(start,-1)};
}
export const deliveryDay=order=>validDay(order.deliveryDate)?order.deliveryDate:validDay(order.date)?order.date:'';
export function savedAmount(order) {
  let value=0,missing=0;
  for(const item of order.items || []) {
    if(item.price===null||item.price===undefined||item.price===''||!Number.isFinite(Number(item.price)))missing++;
    else value+=roundAmount(Number(item.qty || 0)*Number(item.price));
  }
  return {amount:roundAmount(value),missing};
}
function summarize(orders) {
  const amounts=orders.map(savedAmount),missing=amounts.reduce((n,row)=>n+row.missing,0);
  const amount=roundAmount(amounts.reduce((sum,row)=>sum+row.amount,0));
  return {amount,missing,count:orders.length,stores:new Set(orders.map(order=>order.storeId)).size,
    average:missing?null:orders.length?roundAmount(amount/orders.length):0};
}
export function businessAnalytics(model,range,{includeDemo=false}={}) {
  const actual=model.state.orders.filter(order=>includeDemo||!order.isDemo);
  const delivered=actual.filter(order=>order.stage==='delivered');
  const inRange=(order,start,end)=>deliveryDay(order)>=start&&deliveryDay(order)<=end;
  const current=delivered.filter(order=>inRange(order,range.start,range.end));
  const previous=delivered.filter(order=>inRange(order,range.previousStart,range.previousEnd));
  const daily=new Map();
  for(let i=0;i<range.days;i++){const date=shiftDay(range.start,i);daily.set(date,{start:date,end:date,amount:0,count:0,missing:0});}
  for(const order of current) {const day=daily.get(deliveryDay(order)),value=savedAmount(order);day.amount=roundAmount(day.amount+value.amount);day.missing+=value.missing;day.count++;}
  const step=range.days<=31?'day':range.days<=120?'week':'month',buckets=new Map();
  [...daily.values()].forEach((day,index)=>{
    const key=step==='day'?day.start:step==='week'?Math.floor(index/7):day.start.slice(0,7);
    if(!buckets.has(key))buckets.set(key,{...day,amount:0,count:0,missing:0});
    const bucket=buckets.get(key);bucket.end=day.end;bucket.amount=roundAmount(bucket.amount+day.amount);bucket.count+=day.count;bucket.missing+=day.missing;
  });
  const storeMap=new Map(),storeFor=id=>{
    if(!storeMap.has(id))storeMap.set(id,{store:model.getStore(id)||{id,name:'已停用门店'},amount:0,previousAmount:0,count:0,previousCount:0,missing:0,previousMissing:0,lastOrder:''});
    return storeMap.get(id);
  };
  for(const [orders,isPrevious] of [[current,false],[previous,true]])for(const order of orders){
    const row=storeFor(order.storeId),value=savedAmount(order);
    if(isPrevious){row.previousAmount=roundAmount(row.previousAmount+value.amount);row.previousCount++;row.previousMissing+=value.missing;}
    else{row.amount=roundAmount(row.amount+value.amount);row.count++;row.missing+=value.missing;}
  }
  for(const order of actual){const row=storeMap.get(order.storeId);if(!row)continue;
    const submitted=order.submittedAt ? new Date(order.submittedAt) : null;
    const day=submitted && !Number.isNaN(submitted.getTime()) ? tokyoDayFormat.format(submitted) : String(order.date || order.deliveryDate);
    if(validDay(day)&&day>row.lastOrder)row.lastOrder=day;
  }
  const products=new Map();
  for(const order of current)for(const line of order.items || []) {
    if(!products.has(line.productId))products.set(line.productId,{product:model.getProduct(line.productId)||{id:line.productId,name:line.productName||line.productId},amount:0,missing:0,orders:new Set(),quantities:new Map()});
    const row=products.get(line.productId),value=savedAmount({items:[line]});row.amount=roundAmount(row.amount+value.amount);row.missing+=value.missing;row.orders.add(order.id);
    const unit=line.unit||row.product.unit||'单位未记录';row.quantities.set(unit,Math.round(((row.quantities.get(unit)||0)+Number(line.qty||0))*1000)/1000);
  }
  const orders=actual.filter(order=>inRange(order,range.start,range.end));
  return {range,orders,current:summarize(current),previous:summarize(previous),buckets:[...buckets.values()],step,
    stores:[...storeMap.values()].sort((a,b)=>b.amount-a.amount||b.previousAmount-a.previousAmount||b.count-a.count),
    products:[...products.values()].map(row=>({...row,count:row.orders.size,quantities:[...row.quantities].map(([unit,qty])=>({unit,qty}))})).sort((a,b)=>b.amount-a.amount||b.count-a.count)};
}
export function businessTasks(model,today=tokyoDate(),{includeDemo=false}={}) {
  const active=model.state.orders.filter(order=>(includeDemo||!order.isDemo)&&['pending','packing','ready','delivering'].includes(order.stage));
  const todayOrders=active.filter(order=>deliveryDay(order)===today);
  const issues=active.filter(orderHasOpenIssue),overdue=active.filter(order=>deliveryDay(order)&&deliveryDay(order)<today);
  const packing=todayOrders.filter(order=>['pending','packing'].includes(order.stage)),ready=todayOrders.filter(order=>order.stage==='ready');
  const low=model.getProducts().filter(product=>(includeDemo||!product.isDemo)&&model.getStock(product.id)!==null&&model.getStock(product.id)<6);
  const tasks=[];
  for(const order of active) {
    const date=deliveryDay(order),kind=orderHasOpenIssue(order)?'issue':date&&date<today?'overdue':date===today&&['pending','packing'].includes(order.stage)?'packing':date===today&&order.stage==='ready'?'ready':null;
    if(!kind)continue;
    const details=[];
    if(order.issue&&!order.issueResolvedAt)details.push({text:order.issue});
    for(const line of order.items||[])if(isPackingShortage(line))details.push({productId:line.productId,text:`${line.productName||model.getProduct(line.productId)?.name||line.productId}：${line.packingNote||'待补货'}`});
    tasks.push({id:`order:${order.id}`,source:'system',kind,title:order.storeName||model.getStore(order.storeId)?.name||'已停用门店',
      description:details.map(item=>item.text).join('；')||({overdue:'已超过配送日期',packing:'核对商品并完成配货',ready:'配货已完成，待安排配送'}[kind]||''),
      orderId:order.id,date,dueDate:date||null,isOverdue:Boolean(date&&date<today),stage:order.stage,isDemo:Boolean(order.isDemo),issues:details});
  }
  for(const product of low)tasks.push({id:`product:${product.id}`,source:'system',kind:'stock',title:product.name,
    description:`可订库存 ${model.getStock(product.id)} ${product.unit||''}`.trim(),productId:product.id,date:today,dueDate:null,isOverdue:false,isDemo:Boolean(product.isDemo)});
  // Source describes how a task entered this list, not who reported an issue.
  const manual=(model.state.manualTasks||[]).filter(task=>!task.deletedAt).map(task=>({id:`manual:${task.id}`,manualId:task.id,source:'manual',kind:'manual',
    title:task.title,description:task.note||'',date:task.createdAt?tokyoDayFormat.format(new Date(task.createdAt)):'',createdAt:task.createdAt,completedAt:task.completedAt||null,
    dueDate:validDay(task.dueDate)?task.dueDate:null,isOverdue:!task.completedAt&&validDay(task.dueDate)&&task.dueDate<today,
    completedDate:task.completedAt?tokyoDayFormat.format(new Date(task.completedAt)):''}));
  tasks.push(...manual.filter(task=>!task.completedAt));
  const completedTasks=manual.filter(task=>task.completedAt).sort((a,b)=>b.completedAt.localeCompare(a.completedAt));
  const priority={issue:0,overdue:1,manual:2,packing:3,ready:3,stock:4};
  const urgency=task=>task.kind==='issue'?0:task.isOverdue?1:priority[task.kind];
  tasks.sort((a,b)=>urgency(a)-urgency(b)||(a.dueDate||'9999-12-31').localeCompare(b.dueDate||'9999-12-31')||a.date.localeCompare(b.date)||a.id.localeCompare(b.id));
  return {today,packing,ready,delivering:todayOrders.filter(order=>order.stage==='delivering'),issues,overdue,low,tasks,completedTasks};
}
export function notificationQueue(model,role='admin',storeId='',{includeDemo=false}={}) {
  const orders=model.state.orders.filter(order=>(includeDemo||!order.isDemo)&&['pending','packing','ready','delivering'].includes(order.stage)&&(role==='admin'||order.storeId===storeId))
    .slice().sort((a,b)=>Number(orderHasOpenIssue(b))-Number(orderHasOpenIssue(a))||String(a.deliveryDate).localeCompare(String(b.deliveryDate)));
  const low=role==='admin'?model.getProducts().filter(product=>model.getStock(product.id)!==null&&model.getStock(product.id)<6):[];
  return {orders,low,count:orders.length+low.length};
}
