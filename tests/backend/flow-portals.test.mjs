import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {KitchenModel} from '../../src/shared/data.js';
import {seedTenant} from '../../backend/repository.js';
import {createFlowStore} from '../../backend/flow-store.js';
import {createAttachmentStore} from '../../backend/flow-attachments.js';
import {createFlowDataContext,runFlowTool} from '../../backend/flow-tools.js';
import {handleFlow} from '../../backend/flow-service.js';
import {getPortalFeaturePolicy} from '../../backend/portal-features.js';
import {handlePlatformFlow} from '../../backend/flow-control.js';
import {flowStorageScope} from '../../backend/flow-scope.js';
const origin='https://portal-flow.example.test';
const admin={role:'admin',accountRole:'owner',tenantId:'tenant-a',userId:'person-a'},shop={role:'store',accountRole:'owner',tenantId:'tenant-a',storeId:'store-a',userId:'person-a'},platform={role:'platform',accountRole:'owner',userId:'person-a'};
class D1 {
  constructor(){this.sql=new DatabaseSync(':memory:');const directory=new URL('../../backend/migrations/',import.meta.url);for(const name of readdirSync(directory).filter(n=>n.endsWith('.sql')).sort())this.sql.exec(readFileSync(new URL(name,directory),'utf8'));}
  prepare(sql){const make=(args=[])=>({bind:(...v)=>make(v),first:async()=>this.sql.prepare(sql).get(...args)||null,all:async()=>({results:this.sql.prepare(sql).all(...args)}),run:async()=>({success:true,meta:this.sql.prepare(sql).run(...args)}),sync:()=>{const stmt=this.sql.prepare(sql);return stmt.columns().length?{results:stmt.all(...args),meta:{changes:0}}:{results:[],meta:stmt.run(...args)};}});return make();}
  async batch(statements){this.sql.exec('BEGIN');try{const result=statements.map(s=>s.sync());this.sql.exec('COMMIT');return result;}catch(error){this.sql.exec('ROLLBACK');throw error;}}
}
function request(route,body){return new Request(origin+route,{headers:{Origin:origin,'Content-Type':'application/json'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});}
async function fixture(){
  const DB=new D1(),model=new KitchenModel();model.storage=null;model.save=()=>{};
  Object.assign(model.state,{stores:[{id:'store-a',name:'Our shop',address:'Our address',accessCode:'PRIVATE-CODE',contact:'PRIVATE-CONTACT'},{id:'store-b',name:'FOREIGN-STORE',address:'Foreign'}],products:[],orders:[],documents:[],inventory:{},prices:{},quoteMeta:{},unitQuotes:{},quotePlans:[]});
  const product=model.addProduct({name:'Allowed product',category:'冷冻品',unit:'箱',spec:'10KG',stock:100,costPrice:12});
  const hidden=model.addProduct({name:'UNQUOTED-PRODUCT',category:'冷冻品',unit:'箱',stock:100});
  model.setUnitQuote('store-a',product.id,'箱',100,'exclusive',0.08);model.setUnitQuote('store-b',product.id,'箱',777777,'exclusive',0.08);
  product.costPrice=123456;product.secret='PRIVATE-SECRET';model.state.privateMaterials={materialCosts:[{cost:123456,secret:'PRIVATE-MATERIAL'}]};
  model.state.orders=Array.from({length:105},(_,i)=>({id:'order-'+i,storeId:'store-a',storeName:'Our shop',date:'2026-10-25',deliveryDate:'2026-10-25',stage:'delivered',items:[{productId:product.id,productName:product.name,qty:1,price:i===0?null:8,unit:'箱',costPrice:123456}],submittedAt:'2026-10-25T00:00:00Z'}));
  model.state.orders.push({id:'FOREIGN-ORDER',storeId:'store-b',date:'2026-10-25',stage:'delivered',items:[{productId:product.id,qty:1,price:777777}],submittedAt:'2026-10-25T00:00:00Z'});
  await seedTenant(DB,{tenantId:'tenant-a',state:model.state});await seedTenant(DB,{tenantId:'tenant-b',state:{...model.state,orders:[],products:[],stores:[]}});
  for(const id of ['tenant-a','tenant-b'])await DB.prepare('INSERT INTO organizations(tenant_id,code,created_at) VALUES(?,?,1)').bind(id,'PRIVATE-ORG-'+id).run();
  for(const p of [admin,shop,platform]){const id=p.role+'-person';await DB.prepare("INSERT INTO staff_accounts(id,login_id,tenant_id,store_id,role,account_role,name,contact,status,password_hash,created_at) VALUES(?,?,?,?,?,'owner',?,'PRIVATE-CONTACT','active','PRIVATE-HASH',1)").bind(id,'PRIVATE-LOGIN-'+id,p.tenantId||null,p.storeId||null,p.role,p.role+' name').run();}
  const env={DB,PUBLIC_ORIGIN:origin,STORE_CODE_KEY:'7'.repeat(64)},store=createFlowStore(env);
  const provider={async status(p){const saved=await store.getConnection(p);return{provider:'copilot',configured:!!saved,connected:!!saved,models:saved?[{id:'model-a',name:'Model A'}]:[],model:'model-a'};},async loginToken(p,token){const saved=await store.getConnection(p);await store.saveConnection(p,{githubToken:token,model:'model-a'},saved?.version??null);return this.status(p);}};
  const config=req=>handlePlatformFlow(req,env,{}, {identity:async()=>platform,store,provider});
  return{env,store,provider,config,product,hidden};
}
test('platform connection uses its own encrypted namespace without creating a customer or borrowing tokens',async()=>{
  const h=await fixture();const count=h.env.DB.sql.prepare('SELECT count(*) n FROM tenants').get().n;
  for(const [tenantId,token] of [['tenant-a','manager-token'],['@platform','platform-token']])assert.equal((await h.config(request('/api/platform/flow/connection',{tenantId,token}))).status,200);
  assert.equal((await h.store.getConnection(admin)).data.githubToken,'manager-token');assert.equal((await h.store.getConnection(shop)).data.githubToken,'manager-token');assert.equal((await h.store.getConnection(platform)).data.githubToken,'platform-token');
  assert.equal(h.env.DB.sql.prepare('SELECT count(*) n FROM tenants').get().n,count);
  const value=await (await h.config(request('/api/platform/flow?tenant=@platform'))).json();assert.doesNotMatch(JSON.stringify(value),/platform-token|manager-token|PRIVATE-/);
  assert.equal((await h.config(request('/api/platform/flow',{tenantId:'@platform',version:value.version,enabled:true,model:'model-a'}))).status,200);
  assert.equal((await getPortalFeaturePolicy(h.env,platform)).flowEnabled,true);assert.equal((await getPortalFeaturePolicy(h.env,admin)).flowEnabled,false);
  await assert.rejects(h.store.saveConnection(shop,{githubToken:'replace'}),{status:403});await assert.rejects(h.store.saveConnection({...platform,accountRole:'member'},{githubToken:'replace'}),{status:403});
});
test('six portal flags are independent, scoped and atomically versioned, with compatible defaults',async()=>{
  const h=await fixture();assert.deepEqual(await getPortalFeaturePolicy(h.env,shop),{flowEnabled:false,multilingualEnabled:false,notificationsEnabled:true,version:0});
  await h.config(request('/api/platform/flow/connection',{tenantId:'tenant-a',token:'manager-token'}));
  const matrix={admin:{flowEnabled:false,multilingualEnabled:true,notificationsEnabled:false},store:{flowEnabled:true,multilingualEnabled:false,notificationsEnabled:true}};
  const save=()=>h.config(request('/api/platform/flow',{tenantId:'tenant-a',version:0,enabled:false,model:'model-a',portals:matrix}));const results=await Promise.all([save(),save()]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  assert.deepEqual(await getPortalFeaturePolicy(h.env,admin),{...matrix.admin,version:1});assert.deepEqual(await getPortalFeaturePolicy(h.env,shop),{...matrix.store,version:1});
  assert.equal((await getPortalFeaturePolicy(h.env,{...shop,tenantId:'tenant-b'})).flowEnabled,false);
  const bad=await h.config(request('/api/platform/flow',{tenantId:'tenant-a',version:1,enabled:true,portals:matrix}));assert.equal(bad.status,400);
  await assert.rejects(getPortalFeaturePolicy(h.env,{...platform,tenantId:'tenant-a'}),{status:403});
});
test('store Flow loads all history and only own orderable products and prices without cost, credentials or other stores',async()=>{
  const h=await fixture(),context=await createFlowDataContext(h.env.DB,shop),search=await runFlowTool(context,'flow_search',{limit:30});
  const product=await runFlowTool(context,'flow_get_record',{kind:'product',id:h.product.id});assert.equal(product.data.prices[0].price,100);
  const summary=await runFlowTool(context,'flow_business_summary',{});assert.equal(summary.data.total,105);assert.equal(summary.data.knownDeliveredAmount,832);assert.equal(summary.data.unknownAmountOrders,1);assert.equal(summary.data.missingPriceLines,1);
  assert.doesNotMatch(JSON.stringify([context.snapshot,search,product,summary]),/FOREIGN-|PRIVATE-|123456|777777|UNQUOTED-PRODUCT|quotePlan|password|costPrice/);
  await assert.rejects(runFlowTool(context,'flow_get_record',{kind:'order',id:'FOREIGN-ORDER'}),{status:404});
  await assert.rejects(runFlowTool(context,'flow_set_inventory',{productId:h.product.id,quantity:0}),{status:403});
});
test('platform Flow sees safe directory summaries, no business prices or credentials, and member sees no other staff records',async()=>{
  const h=await fixture(),context=await createFlowDataContext(h.env.DB,platform),result=await runFlowTool(context,'flow_search',{limit:30});
  assert.equal(result.data.results.filter(r=>r.kind==='company').length,2);
  assert.doesNotMatch(JSON.stringify(context.snapshot),/PRIVATE-|123456|777777|password|login_id|core_json|price/);
  const member=await createFlowDataContext(h.env.DB,{...platform,accountRole:'member',userId:'platform-person'});assert.equal(member.index.accounts,1);
  await assert.rejects(runFlowTool(context,'flow_get_record',{kind:'order',id:'order-1'}),{status:404});
  await assert.rejects(runFlowTool(context,'flow_delete_store',{storeId:'store-a'}),{status:403});
});
test('conversations, attachments and artifacts isolate role/store/person; existing management storage keys remain identical',async()=>{
  const h=await fixture(),actors=[admin,shop,{...shop,storeId:'store-b'},platform];assert.deepEqual(flowStorageScope(admin),['tenant-a','person-a']);
  const ids=[];for(const p of actors){const c=await h.store.save(p,{messages:[],draft:p.role});ids.push(c.id);assert.equal((await h.store.list(p)).conversations.length,1);}
  for(let a=0;a<actors.length;a++)for(let b=0;b<actors.length;b++)if(a!==b)await assert.rejects(h.store.get(actors[a],ids[b]),{status:404});
  await h.store.remove(shop,ids[1]);assert.equal((await h.store.list(shop)).conversations.length,0);assert.equal((await h.store.restore(shop,ids[1])).draft,'store');
  const image=await h.store.createArtifact(shop,{svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="20" height="20"/></svg>',title:'Store image'});await assert.rejects(h.store.getArtifact(admin,image.id),{status:404});
  const attachments=createAttachmentStore(h.env),attachment=await attachments.put(shop,{id:crypto.randomUUID(),name:'note.txt',kind:'text',bytes:10,parts:[{label:'第 1 页',text:'Store note'}]});await assert.rejects(attachments.get({...shop,storeId:'store-b'},attachment.id),{status:404});await assert.rejects(attachments.get(platform,attachment.id),{status:404});
});
test('store and platform requests stream permitted tools but reject every confirmed-write route',async()=>{
  const h=await fixture();
  for(const p of [shop,platform]){
    const provider={...h.provider,status:async()=>({provider:'copilot',configured:true,connected:true,model:'model-a',models:[{id:'model-a'}]}),async chat(options){assert.ok(options.toolDefinitions.every(t=>!t.name.startsWith('flow_set_')&&!t.name.includes('create_')&&!t.name.includes('delete_')));assert.match(options.systemPrompt,/只读/);const result=await options.runTool('flow_business_summary',{});assert.ok(result.data.complete);options.onEvent({type:'message',text:'已完成查询。'});await assert.rejects(options.runTool('flow_set_inventory',{productId:h.product.id,quantity:0}),{status:403});}};
    const handle=req=>handleFlow(req,h.env,{}, {identity:async()=>p,store:h.store,provider,getPolicy:async()=>({enabled:true,model:'model-a',version:1})});
    assert.equal((await handle(request('/api/flow/actions/'+crypto.randomUUID()+'/confirm',{}))).status,403);
    const response=await handle(request('/api/flow/chat',{message:'汇总',requestId:crypto.randomUUID()}));assert.equal(response.status,200);const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.ok(events.some(e=>e.type==='done'));assert.ok(!events.some(e=>e.type==='mutation'||e.type==='proposal'));
  }
});
