import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {JSDOM,VirtualConsole} from 'jsdom';
import {setImmediate as tick} from 'node:timers/promises';
import {projectRoot} from '../../scripts/lib/project-paths.mjs';

const bundle=(await build({stdin:{contents:`export {createBusinessUI} from './src/features/catalogue/business-ui.js'; export {KitchenModel} from './src/shared/data.js'; export {initSelectControls} from './src/ui/ui-controls.js';`,resolveDir:projectRoot},bundle:true,write:false,format:'iife',globalName:'Ordering',logLevel:'silent',plugins:[{name:'empty-seed',setup(b){b.onResolve({filter:/business-data\.js$/},()=>({path:projectRoot+'/src/shared/cloud-seed.js'}));}}]})).outputFiles[0].text;
function fixture(t,description=''){
 const errors=[],console=new VirtualConsole();console.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM('<style>.ordering-filterbar{position:sticky}</style><main></main><div id="overlay-root"></div>',{url:'https://ordering.example.test',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:console});
 const w=dom.window,d=w.document,frames=new Map(),scrolls=[];let id=0;
 w.matchMedia=()=>({matches:false,addEventListener(){},removeEventListener(){}});
 w.requestAnimationFrame=cb=>{frames.set(++id,cb);return id;};w.cancelAnimationFrame=key=>frames.delete(key);
 Object.defineProperty(w,'scrollY',{value:1500,writable:true});w.scrollTo=options=>{scrolls.push(options);w.scrollY=options.top;};
 const rect=(top,height,width=388)=>({top,bottom:top+height,left:16,right:16+width,width,height,x:16,y:top});
 w.HTMLElement.prototype.getBoundingClientRect=function(){if(this.matches('.topbar'))return rect(0,52);if(this.matches('.ordering-filterbar'))return rect(52,100);if(this.matches('.quick-order-table,.product-grid'))return rect(350-w.scrollY,800);if(this.matches('.ui-select-trigger'))return rect(200,28,52);return rect(0,0);};
 w.eval(bundle);
 const model=Object.assign(Object.create(w.Ordering.KitchenModel.prototype),{state:{products:[{id:'p1',name:'商品甲',category:'冷冻品',unit:'KG',spec:'15KG/箱',image:'/api/images/test',description,saleUnits:[{unit:'KG',perBase:1},{unit:'箱',perBase:1/15}]},{id:'p2',name:'商品乙',category:'常温品',unit:'袋',spec:'袋'}],stores:[{id:'s1',name:'门店'}],prices:{s1:{p1:100,p2:50}},quoteMeta:{},unitQuotes:{},inventory:{},storeAllocations:{},orders:[],cart:{},cartUnits:{},activeStoreId:'s1'}});
 const ui={role:'client',page:'products',category:'全部商品',query:''};
 const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let business;
 const ctx={isCloud:true,model,ui,escape,money:String,icon:()=>'<svg></svg>',button:(label,action)=>`<button data-action="${action}">${label}</button>`,activeStore:()=>model.getStore('s1'),titleHeading:()=>'',clientStoreSelect:()=>'',clientStoreHeader:()=>'',cartPanel:()=>'',qtyControl:()=>'',mobileCartBar:()=>'',emptyState:()=>'<p>空</p>',render:()=>{d.querySelector('main').innerHTML='<header class="topbar"></header>'+business.clientProductsPage();},modal:(title,body,footer)=>{d.getElementById('overlay-root').innerHTML=`<section class="modal" role="dialog"><h2>${title}</h2>${body}${footer}</section>`;}};
 business=w.Ordering.createBusinessUI(ctx);ctx.render();
 d.addEventListener('click',e=>{const el=e.target.closest('[data-action]');if(el)business.handleAction(el.dataset.action,el);});
 const flush=()=>{const pending=[...frames.values()];frames.clear();pending.forEach(cb=>cb());};
 t.after(()=>{w.close();assert.deepEqual(errors,[]);});
 return {w,d,ui,business,ctx,flush,scrolls};
}

test('switching a scrolled category aligns the new list below the sticky header and filters',t=>{
 const {d,flush,scrolls}=fixture(t);
 d.querySelector('[data-category="常温品"]').click();flush();
 assert.equal(d.querySelector('.quick-name').textContent,'商品乙');assert.equal(scrolls.length,1);assert.equal(scrolls[0].top,190);
 assert.equal(scrolls[0].behavior,'instant');
});
test('rapid category changes use the final selection, and a pending scroll cannot move another page',t=>{
 const {d,ui,flush,scrolls}=fixture(t);
 d.querySelector('[data-category="冷冻品"]').click();d.querySelector('[data-category="常温品"]').click();flush();assert.equal(scrolls.length,1);
 d.querySelector('[data-category="全部商品"]').click();ui.page='my-orders';flush();assert.equal(scrolls.length,1);
});
test('image and table product photos open shared large-image details with escaped optional description',t=>{
 const {d,ui,ctx}=fixture(t,'冷藏保存\n<b>原文</b>');
 d.querySelector('.quick-product-photo').click();
 assert.ok(d.querySelector('.client-product-details .product-detail-image'));
 assert.equal(d.querySelector('.product-detail-description').textContent,'冷藏保存\n<b>原文</b>');assert.equal(d.querySelector('.product-detail-description b'),null);
 ui.productView='cards';ctx.render();d.querySelector('.product-image-button').click();assert.ok(d.querySelector('.client-product-details'));
});
test('a product without a description adds no empty description section',t=>{
 const {d}=fixture(t);d.querySelector('.quick-product-photo').click();assert.equal(d.querySelector('.product-detail-description'),null);
});
test('unit popup stays compact and keyboard-operable while normal selects keep their existing width',async t=>{
 const {w,d}=fixture(t);d.body.insertAdjacentHTML('beforeend','<select id="normal"><option>A</option><option>B</option></select>');w.Ordering.initSelectControls();await tick();
 const trigger=d.querySelector('.sale-unit-picker .ui-select-trigger');trigger.click();
 assert.equal(d.querySelector('.ui-select-menu').style.width,'80px');assert.ok(d.querySelector('.ui-select-menu-unit'));
 trigger.dispatchEvent(new w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));trigger.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
 assert.equal(d.querySelector('.sale-unit-select').value,'箱');assert.equal(d.querySelector('.ui-select-menu'),null);
 d.querySelector('#normal').parentElement.querySelector('.ui-select-trigger').click();assert.equal(d.querySelector('.ui-select-menu').style.width,'180px');assert.equal(d.querySelector('.ui-select-menu-unit'),null);
});
