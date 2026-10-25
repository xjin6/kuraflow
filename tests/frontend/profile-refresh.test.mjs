import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createCloudModel} from '../../src/app/cloud-client.js';

const initialState=()=>({version:2,products:[{id:'p1',name:'测试商品',unit:'袋',stock:20,active:true}],stores:[{id:'store-a',name:'测试门店'}],orders:[],documents:[],prices:{},quoteMeta:{},unitQuotes:{},inventory:{p1:20},storeAllocations:{},settings:{companyName:'测试厨房'},cart:{},cartUnits:{},activeStoreId:'store-a'});
function installWindow(t,draft={}){
  const values=new Map([['kuraflow-draft:tenant-a:person-a',JSON.stringify(draft)]]);
  const old=Object.getOwnPropertyDescriptor(globalThis,'window'),window=new EventTarget();
  window.localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  Object.defineProperty(globalThis,'window',{configurable:true,value:window});
  t.after(()=>old?Object.defineProperty(globalThis,'window',old):delete globalThis.window);
  return values;
}

test('cloud refresh updates shared avatar identities at the same business revision and keeps unsent drafts',async t=>{
  const persisted=installWindow(t,{cart:{p1:3},cartUnits:{p1:'袋'},cartNote:'尚未提交的备注',cartDeliveryDate:'2026-11-02',activeStoreId:'store-a'});
  const person={userId:'person-a',tenantId:'tenant-a',role:'admin',accountRole:'owner',displayName:'旧名字',avatarUrl:null,avatarVersion:0,organizationAvatarUrl:null,organizationAvatarVersion:0};
  const session={principal:person,state:initialState(),revision:7};
  const model=createCloudModel(session),draft=structuredClone({cart:model.state.cart,cartUnits:model.state.cartUnits,cartNote:model.state.cartNote,cartDeliveryDate:model.state.cartDeliveryDate});
  let metadata={...person,displayName:'新名字',avatarUrl:'/api/account-avatar?account=person-a&v=2',avatarVersion:2,organizationAvatarUrl:'/api/organization-avatar?tenant=tenant-a&v=3',organizationAvatarVersion:3};
  t.mock.method(globalThis,'fetch',async route=>{
    assert.equal(route,'/api/state');
    return new Response(JSON.stringify({revision:7,principal:metadata,state:{...initialState(),settings:{companyName:'不应因相同业务修订覆盖'}}}),{headers:{'Content-Type':'application/json'}});
  });
  assert.equal(await model.refresh(),true,'avatar changes request a shell repaint even when business data is unchanged');
  assert.equal(session.principal,person,'the shell and cloud model retain the same shared identity object');
  assert.equal(person.avatarUrl,metadata.avatarUrl);assert.equal(person.avatarVersion,2);
  assert.equal(person.organizationAvatarUrl,metadata.organizationAvatarUrl);assert.equal(person.organizationAvatarVersion,3);
  assert.equal(person.displayName,'新名字');assert.equal(person.role,'admin');assert.equal(person.tenantId,'tenant-a');
  assert.equal(model.revision,7);assert.equal(model.state.settings.companyName,'测试厨房');
  assert.deepEqual({cart:model.state.cart,cartUnits:model.state.cartUnits,cartNote:model.state.cartNote,cartDeliveryDate:model.state.cartDeliveryDate},draft);
  assert.equal(JSON.parse(persisted.get('kuraflow-draft:tenant-a:person-a')).avatarUrl,undefined,'profile state is never written into business draft storage');
  assert.equal(await model.refresh(),false,'an identical profile and business snapshot needs no repaint');
  metadata={...metadata,avatarUrl:null,avatarVersion:4};
  assert.equal(await model.refresh(),true);assert.equal(person.avatarUrl,null,'removing a portrait also propagates without a business revision');
});

test('failed avatar refresh leaves current identity and pending business drafts intact',async t=>{
  installWindow(t,{cart:{p1:2},cartNote:'网络中断时保留'});
  const person={userId:'person-a',tenantId:'tenant-a',role:'admin',displayName:'员工',avatarUrl:'/api/account-avatar?account=person-a&v=1',avatarVersion:1};
  const model=createCloudModel({principal:person,state:initialState(),revision:2}),before=structuredClone(person),cart=structuredClone(model.state.cart);
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({error:'暂时不可用'}),{status:503,headers:{'Content-Type':'application/json'}}));
  await assert.rejects(model.refresh(),/暂时不可用/);
  assert.deepEqual(person,before);assert.deepEqual(model.state.cart,cart);assert.equal(model.state.cartNote,'网络中断时保留');assert.equal(model.revision,2);
});
