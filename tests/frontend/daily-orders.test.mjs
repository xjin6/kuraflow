import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import {projectRoot} from '../../scripts/lib/project-paths.mjs';
const bundle=(await build({entryPoints:[projectRoot+'/src/features/orders/daily-orders-ui.js'],bundle:true,write:false,format:'iife',globalName:'Daily',logLevel:'silent'})).outputFiles[0].text;
function fixture(t,role='client'){
 const dom=new JSDOM('<main></main>',{url:'https://daily.example.test/?view=client&page=my-orders',runScripts:'outside-only'});t.after(()=>dom.window.close());
 const {window:w}=dom;w.eval(bundle);
 const row=(id,storeId,price,qty,stage='pending')=>({id,storeId,deliveryDate:'2026-10-30',stage,items:[{productId:'p1',productName:'原品名<script>无脚本</script>',spec:'15KG/箱',unit:'KG',perBase:1,qty,price,taxBasis:'exclusive',taxRate:.08}]});
 const model={state:{orders:[row('a','s1',100,2),row('b','s1',120,3,'delivered'),row('other','s2',700,1)]},getStore:id=>({id,name:id==='s1'?'本店':'别家门店'}),getProduct:()=>({})};
 const ui={role,orderView:'daily'},exports=[];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const button=(label,action,type,extra='')=>`<button data-action="${action}" ${extra}>${label}</button>`;
 const api=w.Daily.createDailyOrdersUI({model,ui,escape:esc,money:v=>'¥'+v,button,icon:()=>'',storeAvatar:()=>'',activeStore:()=>({id:'s1'}),render(){},emptyState:()=>'<p>空</p>',exportRecord:async(...args)=>exports.push(args)});
 return {w,model,ui,api,exports};
}
test('store merged cards retain original order details and price tiers without displaying another store',t=>{
 const {w,model,api}=fixture(t);const groups=api.groups(model.state.orders);assert.equal(groups.length,1);
 w.document.querySelector('main').innerHTML=api.modeSwitch()+api.cards(groups);
 assert.equal(w.document.querySelectorAll('.daily-order-card').length,1);assert.equal(w.document.querySelector('.daily-product-qty').textContent.trim(),'5 KG');
 assert.equal(w.document.querySelectorAll('.daily-price-breakdown > div').length,2);assert.equal(w.document.querySelectorAll('.daily-original-row').length,2);assert.equal(w.document.querySelector('.daily-originals [data-action="order-detail"]'),null);
 assert.doesNotMatch(w.document.body.textContent,/别家门店/);assert.equal(w.document.querySelector('script'),null);assert.match(w.document.body.textContent,/原品名<script>/);
});
test('daily export recomputes the complete own-store group and rejects forged foreign group keys',async t=>{
 const {model,api,exports}=fixture(t);const group=api.groups(model.state.orders)[0];
 await api.handleAction('daily-order-pdf',{dataset:{key:group.key}});assert.equal(exports[0][0].orders.length,2);assert.equal(exports[0][0].amount,560);
 await assert.rejects(api.handleAction('daily-order-pdf',{dataset:{key:JSON.stringify(['s2','2026-10-30',false])}}),/无法查看/);assert.equal(exports.length,1);
});
test('view switching keeps the same controls and preserves the store route',async t=>{
 const {api,ui,w}=fixture(t);const count=(api.modeSwitch().match(/role="tab"/g)||[]).length;
 await api.handleAction('order-view',{dataset:{view:'individual'}});assert.equal(ui.orderView,'individual');assert.equal(new URL(w.location.href).searchParams.get('view'),'client');assert.equal(new URL(w.location.href).searchParams.get('page'),'my-orders');assert.equal((api.modeSwitch().match(/role="tab"/g)||[]).length,count);
});
test('management preserves per-order packing entry rather than mutating a synthetic group',t=>{
 const {w,api,model}=fixture(t,'admin');w.document.body.innerHTML=api.cards(api.groups(model.state.orders));
 assert.equal(w.document.querySelectorAll('.daily-order-card').length,2);const actions=[...w.document.querySelectorAll('[data-action="order-detail"]')].map(e=>e.dataset.id);assert.deepEqual(actions,['a','b','other']);
});
