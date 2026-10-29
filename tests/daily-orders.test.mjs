import {test} from 'node:test';
import assert from 'node:assert/strict';
import {dailyOrderSummary,groupDailyOrders,filterDailyOrders} from '../src/shared/daily-orders.js';
const model={getStore:id=>({id,name:'同名门店'}),getProduct:()=>({name:'当前商品',spec:'当前规格',unit:'KG'}),getUnitQuote:()=>assert.fail('never reprice history')};
const line=(overrides={})=>({productId:'p1',productName:'下单时牛骨',spec:'15KG/箱',unit:'KG',perBase:1,qty:1,price:100,taxBasis:'exclusive',taxRate:.08,...overrides});
const order=(id,overrides={})=>({id,storeId:'s1',deliveryDate:'2026-10-30',submittedAt:'2026-10-29T15:10:00Z',stage:'pending',shipping:0,shippingTax:0,items:[line()],...overrides});

test('daily view combines quantities, retains price tiers and source orders without changing any record',()=>{
 const orders=[order('a',{items:[line({qty:2})]}),order('b',{stage:'packing',items:[line({qty:3,packedQty:2})]}),order('c',{stage:'delivered',items:[line({price:120,packedQty:1})]})],before=structuredClone(orders);
 const result=dailyOrderSummary(model,orders);
 assert.equal(result.orders.length,3);assert.equal(result.summaryLines[0].qty,6);assert.equal(result.summaryLines[0].packedQty,3);assert.equal(result.summaryLines[0].prices.length,2);
 assert.equal(result.lines.length,2);assert.equal(result.lines[0].qty,5);assert.equal(result.lines[1].price,120);assert.equal(result.amount,620);assert.equal(result.tax,49.6);assert.equal(result.gross,669.6);
 assert.deepEqual(result.statuses.map(x=>[x.stage,x.count]),[['pending',1],['packing',1],['delivered',1]]);
 assert.deepEqual(orders,before);assert.equal(result.lines[0].name,'下单时牛骨');assert.equal(result.lines[0].spec,'15KG/箱');
 assert.equal(dailyOrderSummary(model,[...orders,orders[0]]).amount,620);
});
test('store identity, delivery day and demo scope are strict grouping boundaries',()=>{
 const orders=[order('a'),order('b'),order('c',{storeId:'s2'}),order('d',{deliveryDate:'2026-10-31'}),order('e',{isDemo:true})];
 const groups=groupDailyOrders(model,orders);assert.equal(groups.length,4);assert.equal(groups.find(x=>x.store.id==='s1'&&x.day==='2026-10-30'&&!x.order.isDemo).orders.length,2);
 assert.throws(()=>dailyOrderSummary(model,[orders[0],orders[2]]),/同一门店/);assert.throws(()=>dailyOrderSummary(model,[orders[0],orders[3]]),/同一配送日/);
 const invalid=groupDailyOrders(model,[order('x',{deliveryDate:'2026-02-31'}),order('y',{deliveryDate:''})]);assert.equal(invalid.length,2);assert.ok(invalid.every(x=>x.day===''));
});
test('status and ID filters match complete groups, never partial daily quantities',()=>{
 const grouped=groupDailyOrders(model,[order('a'),order('b',{stage:'delivered'})]);
 for(const filter of [{status:'pending'},{query:'b'}]){const rows=filterDailyOrders(grouped,filter);assert.equal(rows.length,1);assert.equal(rows[0].orders.length,2);assert.equal(rows[0].amount,200);}
});
test('different order units and historical specifications stay separate; KG fractions remain exact',()=>{
 const result=dailyOrderSummary(model,[order('a',{items:[line({qty:.125})]}),order('b',{items:[line({qty:.25})]}),order('c',{items:[line({unit:'箱',qty:1,price:1500,perBase:1/15})]})]);
 assert.equal(result.summaryLines.length,2);assert.equal(result.summaryLines[0].qty,.375);assert.equal(result.lines[0].qty,.375);assert.equal(result.summaryLines[1].qty,1);
 assert.equal(dailyOrderSummary(model,[order('a'),order('b',{items:[line({spec:'20KG/箱'})]})]).summaryLines.length,2);
});
test('per-order money and tax rounding are preserved instead of silently recomputing a merged row',()=>{
 const money=dailyOrderSummary(model,[order('a',{items:[line({price:.03,qty:.5})]}),order('b',{items:[line({price:.03,qty:.5})]})]);
 assert.equal(money.amount,.04);assert.equal(money.lines.length,2);assert.equal(money.summaryLines[0].qty,1);
 const tax=dailyOrderSummary(model,[order('a',{items:[line({price:.07})]}),order('b',{items:[line({price:.07})]})]);
 assert.equal(tax.tax,.02);assert.equal(tax.lines.length,2);
});
test('unknown prices, taxes and freight remain unknown with known portions kept separately',()=>{
 const r=dailyOrderSummary(model,[order('a',{shipping:500,shippingTax:40}),order('b',{shipping:null,shippingTax:null,items:[line({price:null,taxRate:null,taxBasis:'unspecified'})]})]);
 assert.equal(r.amount,100);assert.equal(r.gross,null);assert.equal(r.shipping,null);assert.equal(r.shippingTax,null);assert.equal(r.knownShipping,500);assert.equal(r.summaryLines[0].total,null);assert.equal(r.summaryLines[0].knownAmount,100);
});
test('a complete history over 100 orders contributes to the same daily result',()=>{
 const r=dailyOrderSummary(model,Array.from({length:105},(_,i)=>order('history-'+i,{stage:'delivered'})));
 assert.equal(r.orders.length,105);assert.equal(r.summaryLines[0].qty,105);assert.equal(r.amount,10500);assert.equal(r.order.stage,'delivered');
});
