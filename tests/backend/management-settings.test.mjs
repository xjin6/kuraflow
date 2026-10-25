import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile,readdir} from 'node:fs/promises';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {KitchenModel} from '../../src/shared/data.js';
import {executeCommand,getState,loadState,seedTenant,tokyoToday} from '../../backend/repository.js';
let runtime,db;
before(async()=>{runtime=new Miniflare(convertV4MiniflareOptions({workers:[{name:'management-settings',modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-10-08',d1Databases:{DB:'management-settings'}}]}));db=await runtime.getD1Database('DB');for(const file of (await readdir(new URL('../../backend/migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort())await db.exec((await readFile(new URL('../../backend/migrations/'+file,import.meta.url),'utf8')).replace(/--[^\n]*/g,'').replace(/\s+/g,' '));});
after(async()=>runtime?.dispose());
async function fixture(){
 const tenantId=crypto.randomUUID(),principal={tenantId,userId:crypto.randomUUID(),role:'admin'};
 const state={version:2,products:[{id:'p1',name:'测试商品',unit:'袋',category:'冷冻品',stock:20,basePrice:100}],stores:[{id:'s1',name:'门店甲'},{id:'s2',name:'门店乙'}],orders:[],documents:[],prices:{s1:{p1:100},s2:{p1:200}},quoteMeta:{},unitQuotes:{},inventory:{p1:20},storeAllocations:{},priceHistory:[],manualTasks:[],reminders:[],cart:{},settings:{companyName:'测试厨房'}};
 await seedTenant(db,{tenantId,state});
 const command=async(type,args,actor=principal)=>{let extra={};if(type==='submitOrder'&&actor.role==='store'){const snapshot=await loadState(db,tenantId),m=Object.create(KitchenModel.prototype);m.state=snapshot.state;extra.expectedQuotes=Object.fromEntries(Object.keys(args[1]).map(id=>{const unit=args[4]?.[id]||m.getProduct(id).unit;return[id,{...m.getUnitQuote(args[0],id,unit),unit,perBase:m.getUnitFactor(id,unit)}];}));}return executeCommand(db,actor,{type,args,...extra,idempotencyKey:crypto.randomUUID()});};
 const read=async()=>(await loadState(db,tenantId)).state;
 return {tenantId,principal,command,read,store:{...principal,role:'store',storeId:'s1'}};
}

test('quote plans follow current prices for new orders, preserve independent/history prices and never leak plans or costs to stores',async()=>{
 const h=await fixture();await h.command('setProductCost',['p1',65,0]);
 await h.command('setSaleUnitEquations',['p1',[{fromQty:10,fromUnit:'袋',toQty:1,toUnit:'箱'}]]);
 const plan=(await h.command('createQuotePlan',['内部标准方案'])).result;
 await h.command('setQuotePlanPrice',[plan.id,'p1','袋',{price:120,taxBasis:'exclusive',taxRate:.08},1]);
 await h.command('setQuotePlanPrice',[plan.id,'p1','箱',{price:1150,taxBasis:'unspecified',taxRate:null},2]);
 await h.command('setStoreQuotePlan',['s1',plan.id,0]);
 const snapshot=await getState(db,h.store);assert.equal(snapshot.state.prices.s1.p1,120);assert.equal(snapshot.state.unitQuotes.s1.p1.箱.price,1150);
 assert.equal(snapshot.state.products[0].costPrice,undefined);assert.equal(snapshot.state.quotePlans,undefined);assert.equal(snapshot.state.stores[0].quotePlanId,undefined);assert.doesNotMatch(JSON.stringify(snapshot.state),/内部标准方案/);
 const first=(await h.command('submitOrder',['s1',{p1:1},tokyoToday(),''],h.store)).result;
 const version=(await h.read()).quotePlans[0].version;await h.command('setQuotePlanPrice',[plan.id,'p1','袋',{price:150,taxBasis:'unspecified'},version]);
 assert.equal((await h.read()).orders.find(o=>o.id===first.id).items[0].price,120);assert.equal((await getState(db,h.store)).state.prices.s1.p1,150);
 await assert.rejects(h.command('setUnitQuote',['s1','p1','袋',5,'unspecified',null]),/报价方案/);
 await h.command('setStoreQuotePlan',['s1',null,1]);assert.equal((await getState(db,h.store)).state.prices.s1.p1,100);assert.equal((await h.read()).products[0].costPrice,65);
});

test('plan membership and price versions reject stale concurrent changes; store accounts cannot edit them',async()=>{
 const h=await fixture(),a=(await h.command('createQuotePlan',['方案 A'])).result,b=(await h.command('createQuotePlan',['方案 B'])).result;
 await h.command('setStoreQuotePlan',['s2',b.id,0]);
 await assert.rejects(h.command('setQuotePlanMembers',[a.id,['s1','s2'],1,{s1:0,s2:0}]),{status:409});assert.equal((await h.read()).stores[0].quotePlanId,undefined);
 await h.command('setQuotePlanMembers',[a.id,['s1','s2'],1,{s1:0,s2:1}]);assert.ok((await h.read()).stores.every(s=>s.quotePlanId===a.id));
 await assert.rejects(h.command('setQuotePlanPrice',[a.id,'p1','袋',{price:9},1]),{status:409});
 await h.command('createQuotePlan',['方案 C']);await h.command('createQuotePlan',['第四方案']);assert.equal((await h.read()).quotePlans.length,4);await assert.rejects(h.command('createQuotePlan',['第四方案']),/不重复/);
 for(const [name,args] of [['createQuotePlan',['非法方案']],['setProductCost',['p1',1,0]],['enableUnlimitedStock',['p1']],['setStoreQuotePlan',['s1',null,1]],['reorderManualTasks',[[],0]]])await assert.rejects(h.command(name,args,h.store),{status:403});
});

test('unlimited inventory is explicit, survives ordering, respects store allocation and requires a valid new physical count',async()=>{
 const h=await fixture();await h.command('setStoreAllocation',['s1','p1',3]);await h.command('enableUnlimitedStock',['p1']);
 const one=await getState(db,h.store),two=await getState(db,{...h.store,storeId:'s2'});assert.equal(one.state.inventory.p1,3);assert.equal(one.state.products[0].stockUnlimited,false);assert.equal(two.state.inventory.p1,null);assert.equal(two.state.products[0].stockUnlimited,true);
 await assert.rejects(h.command('submitOrder',['s1',{p1:4},tokyoToday(),''],h.store),/库存/);
 await h.command('submitOrder',['s2',{p1:100},tokyoToday(),''],{...h.store,storeId:'s2'});assert.equal((await h.read()).inventory.p1,20);assert.equal((await h.read()).products[0].stockUnlimited,true);
 await assert.rejects(h.command('setWarehouseUnitStock',['p1','袋',1]),/不能少于/);assert.equal((await h.read()).products[0].stockUnlimited,true);
 await h.command('setWarehouseUnitStock',['p1','袋',120]);assert.equal((await h.read()).products[0].stockUnlimited,false);assert.equal((await h.read()).inventory.p1,20);
});

test('source quote units package and 500g persist through quotes, store projection and order stock conversion',async()=>{
 const h=await fixture();
 const weight=(await h.command('addProduct',[{name:'半公斤原价商品',category:'冷冻品',unit:'KG',spec:'15kg/箱',stock:5}])).result;
 const pack=(await h.command('addProduct',[{name:'整包商品',category:'常温品',unit:'包',spec:'包',stock:10}])).result;
 await h.command('setSaleUnitEquations',[weight.id,[{fromQty:1,fromUnit:'KG',toQty:2,toUnit:'500g'}]]);
 const plan=(await h.command('createQuotePlan',['按原计价单位报价'])).result;
 await h.command('setQuotePlanPrice',[plan.id,weight.id,'500g',{price:2160,taxBasis:'exclusive',taxRate:.08},1]);
 await h.command('setQuotePlanPrice',[plan.id,pack.id,'包',{price:260,taxBasis:'exclusive',taxRate:.08},2]);
 await h.command('setStoreQuotePlan',['s1',plan.id,0]);
 const projected=(await getState(db,h.store)).state;
 assert.equal(projected.unitQuotes.s1[weight.id]['500g'].price,2160);
 assert.equal(projected.prices.s1[weight.id],null);
 assert.equal(projected.unitQuotes.s1[pack.id]['包'].price,260);
 const order=(await h.command('submitOrder',['s1',{[weight.id]:3,[pack.id]:2},tokyoToday(),'',{[weight.id]:'500g',[pack.id]:'包'}],h.store)).result;
 assert.equal(order.items[0].unit,'500g');assert.equal(order.items[0].baseQty,1.5);assert.equal(order.items[0].price,2160);
 const state=await h.read();assert.equal(state.inventory[weight.id],3.5);assert.equal(state.inventory[pack.id],8);
 for(const [product,unit] of [[weight,'500g'],[pack,'包']])await assert.rejects(h.command('submitOrder',['s1',{[product.id]:.5},tokyoToday(),'',{[product.id]:unit}],h.store),/整数/);
 await assert.rejects(h.command('setSaleUnitEquations',[weight.id,[{fromQty:1,fromUnit:'KG',toQty:1,toUnit:'500g'}]]),/2 × 500g/);
 assert.equal((await h.read()).products.find(p=>p.id===weight.id).saleUnits.find(u=>u.unit==='500g').perBase,2);
});

test('task edit, durable ordering and restore retain records and reject stale edits',async()=>{
 const h=await fixture(),add=title=>h.command('addManualTask',[{title,note:'备注',dueDate:tokyoToday()}]);
 const a=(await add('A')).result,b=(await add('B')).result,c=(await add('C')).result;
 await h.command('updateManualTask',[a.id,{title:'A 编辑',note:'新备注',dueDate:tokyoToday()},0]);
 await assert.rejects(h.command('updateManualTask',[a.id,{title:'覆盖',note:'',dueDate:tokyoToday()},0]),{status:409});
 await h.command('reorderManualTasks',[[c.id,a.id,b.id],0]);assert.deepEqual((await h.read()).manualTaskOrder,[c.id,a.id,b.id]);
 await assert.rejects(h.command('reorderManualTasks',[[a.id,b.id,c.id],0]),{status:409});
 await h.command('setManualTaskDone',[a.id,true]);await h.command('setManualTaskDone',[a.id,false]);const row=(await h.read()).manualTasks.find(t=>t.id===a.id);assert.equal(row.completedAt,null);assert.equal(row.title,'A 编辑');assert.equal(row.note,'新备注');assert.equal(row.source,'manual');
 assert.equal((await getState(db,h.store)).state.manualTasks,undefined);
});

test('permanent task deletion removes persisted content and sorting, checks version and tenant, and replays safely',async()=>{
 const h=await fixture(),other=await fixture();const a=(await h.command('addManualTask',[{title:'彻底删除测试',note:'敏感备注',dueDate:tokyoToday()}])).result;
 await h.command('reorderManualTasks',[[a.id],0]);
 await assert.rejects(h.command('purgeManualTask',[a.id,0],h.store),{status:403});
 await assert.rejects(other.command('purgeManualTask',[a.id,0]));
 await h.command('setManualTaskDone',[a.id,true]);
 await assert.rejects(h.command('purgeManualTask',[a.id,0]),{status:409});
 const row=(await h.read()).manualTasks.find(t=>t.id===a.id);const command={type:'purgeManualTask',args:[a.id,row.version],idempotencyKey:crypto.randomUUID()};
 const result=await executeCommand(db,h.principal,command);assert.equal(result.result.permanentlyDeleted,true);
 assert.equal((await h.read()).manualTasks.length,0);assert.deepEqual((await h.read()).manualTaskOrder,[]);
 const retry=await executeCommand(db,h.principal,command);assert.equal(retry.replayed,true);
 await assert.rejects(h.command('restoreManualTask',[a.id]));
});
