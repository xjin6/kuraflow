/** Scope keys are internal storage identifiers, never customer records. */
export const PLATFORM_FLOW_SCOPE = '@platform';
const fail=()=>{throw Object.assign(new Error('无权读取此 Flow 数据。'),{status:403,publicError:true});};
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(value);
export function assertFlowScope(principal) {
  if(!principal||!id(principal.userId)||principal.accountRole!=null&&!['owner','member'].includes(principal.accountRole))fail();
  if(principal.role==='platform') {if(principal.tenantId||principal.storeId)fail();}
  else if(principal.role==='admin') {if(!id(principal.tenantId)||principal.storeId)fail();}
  else if(principal.role==='store') {if(!id(principal.tenantId)||!id(principal.storeId))fail();}
  else fail();
  return principal;
}
export function flowStorageScope(principal) {
  assertFlowScope(principal);
  if(principal.role==='platform')return [PLATFORM_FLOW_SCOPE,principal.userId];
  if(principal.role==='store')return [principal.tenantId,JSON.stringify(['store',principal.storeId,principal.userId])];
  return [principal.tenantId,principal.userId];
}
export function flowConnectionScope(principal,write=false) {
  assertFlowScope(principal);
  if(write&&(principal.role==='store'||principal.accountRole!=='owner'))fail();
  return principal.role==='platform'?PLATFORM_FLOW_SCOPE:principal.tenantId;
}
