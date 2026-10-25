import {assertFlowScope,PLATFORM_FLOW_SCOPE} from './flow-scope.js';
const fail=(message,status)=>{throw Object.assign(new Error(message),{status,publicError:true});};
const primary=value=>{const db=value.DB||value;return db.withSession?db.withSession('first-primary'):db;};
export async function getPortalFeatureMatrix(envOrDB,tenantId) {
  const row=await primary(envOrDB).prepare('SELECT t.id,f.flow_enabled,f.flow_model,f.version,u.multilingual_enabled,p.admin_multilingual_enabled,p.admin_notifications_enabled,p.store_flow_enabled,p.store_multilingual_enabled,p.store_notifications_enabled FROM tenants t LEFT JOIN tenant_features f ON f.tenant_id=t.id LEFT JOIN tenant_ui_features u ON u.tenant_id=t.id LEFT JOIN tenant_portal_features p ON p.tenant_id=t.id WHERE t.id=?').bind(tenantId).first();
  if(!row)fail('管理端不存在。',404);
  return {version:row.version||0,model:row.flow_model||null,admin:{flowEnabled:row.flow_enabled===1,multilingualEnabled:(row.admin_multilingual_enabled??row.multilingual_enabled)===1,notificationsEnabled:row.admin_notifications_enabled!==0},store:{flowEnabled:row.store_flow_enabled===1,multilingualEnabled:(row.store_multilingual_enabled??row.multilingual_enabled)===1,notificationsEnabled:row.store_notifications_enabled!==0}};
}
export async function getPortalFeaturePolicy(envOrDB,principal) {
  if(!principal)fail('请先登录。',401);assertFlowScope(principal);
  if(principal.role==='platform') {
    const row=await primary(envOrDB).prepare('SELECT flow_enabled,version FROM platform_features WHERE id=1').first();
    return {flowEnabled:row?.flow_enabled===1,multilingualEnabled:true,notificationsEnabled:true,version:row?.version||0};
  }
  const matrix=await getPortalFeatureMatrix(envOrDB,principal.tenantId);
  return {...matrix[principal.role],version:matrix.version};
}
export async function getPrincipalFlowPolicy(envOrDB,principal) {
  assertFlowScope(principal);
  if(principal.role==='platform') {
    const row=await primary(envOrDB).prepare('SELECT flow_enabled,flow_model,version FROM platform_features WHERE id=1').first();
    return {enabled:row?.flow_enabled===1,model:row?.flow_model||null,version:row?.version||0,scope:PLATFORM_FLOW_SCOPE};
  }
  const matrix=await getPortalFeatureMatrix(envOrDB,principal.tenantId);
  return {enabled:matrix[principal.role].flowEnabled,model:matrix.model,version:matrix.version};
}
export function checkedPortalFlags(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='admin,store')fail('功能配置格式不正确。',400);
  for(const role of ['admin','store'])if(!value[role]||Object.keys(value[role]).sort().join(',')!=='flowEnabled,multilingualEnabled,notificationsEnabled'||Object.values(value[role]).some(flag=>typeof flag!=='boolean'))fail('功能配置格式不正确。',400);
  return structuredClone(value);
}
export function portalFeatureStatement(db,tenantId,matrix,stamp) {
  return db.prepare('INSERT INTO tenant_portal_features(tenant_id,admin_multilingual_enabled,admin_notifications_enabled,store_flow_enabled,store_multilingual_enabled,store_notifications_enabled,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id) DO UPDATE SET admin_multilingual_enabled=excluded.admin_multilingual_enabled,admin_notifications_enabled=excluded.admin_notifications_enabled,store_flow_enabled=excluded.store_flow_enabled,store_multilingual_enabled=excluded.store_multilingual_enabled,store_notifications_enabled=excluded.store_notifications_enabled,updated_at=excluded.updated_at').bind(tenantId,+matrix.admin.multilingualEnabled,+matrix.admin.notificationsEnabled,+matrix.store.flowEnabled,+matrix.store.multilingualEnabled,+matrix.store.notificationsEnabled,stamp);
}
