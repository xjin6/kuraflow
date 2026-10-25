import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {handleFlow} from '../../backend/flow-service.js';
import {handlePlatformFlow} from '../../backend/flow-control.js';
import {createFlowStore} from '../../backend/flow-store.js';
import {createFlowProvider} from '../../backend/flow-provider.js';
import {createFlowArchive} from './flow-archive.mjs';
import {createFlowCopilot} from './flow-copilot.mjs';
import {flowConnectionScope} from '../../backend/flow-scope.js';

const hash=value=>createHash('sha256').update(value).digest('hex');
const safeToken=value=>typeof value==='string'&&/^[a-zA-Z0-9_.-]{16,4096}$/.test(value);
const safeModel=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,120}$/.test(value);

/** Import this application's own local connection once; never overwrite platform changes. */
export async function importLocalFlowConnections({db,privateDir,store}) {
  const {results=[]}=await db.prepare("SELECT tenant_id,id FROM staff_accounts WHERE role='admin' AND account_role='owner' AND status='active' ORDER BY created_at").all();
  const seen=new Set();let imported=0;
  for(const row of results) {
    if(seen.has(row.tenant_id))continue;seen.add(row.tenant_id);
    const principal={role:'admin',accountRole:'owner',tenantId:row.tenant_id,userId:row.id};
    let connection=await store.getConnection(principal);
    if(!connection) {
      let saved;
      try {
        const raw=await fs.readFile(path.join(privateDir,'flow-providers',hash(row.tenant_id)+'.json'),'utf8');
        if(raw.length>20000)continue;saved=JSON.parse(raw);
      } catch(error) {if(error.code==='ENOENT'||error instanceof SyntaxError)continue;throw error;}
      if(saved?.provider!=='copilot'||!safeToken(saved.githubToken))continue;
      const model=saved.copilotModel||saved.model;
      connection=await store.saveConnection(principal,{provider:'copilot',connection:'direct',githubToken:saved.githubToken,model:safeModel(model)?model:'',localLegacyImport:true});
      imported++;
    }
    if(connection.data.localLegacyImport&&connection.version===1) {
      // Restart-safe: only the untouched migration default can be enabled here.
      // Any explicit platform save increments version and takes precedence forever.
      const stamp=new Date().toISOString();
      await db.prepare("INSERT INTO tenant_features(tenant_id,flow_enabled,flow_model,version,updated_at) SELECT ?,1,NULL,1,? WHERE NOT EXISTS(SELECT 1 FROM account_audit WHERE tenant_id=? AND action IN ('flow.feature.enable','flow.feature.disable')) ON CONFLICT(tenant_id) DO UPDATE SET flow_enabled=1,updated_at=excluded.updated_at WHERE tenant_features.version=1 AND tenant_features.flow_model IS NULL AND tenant_features.flow_enabled=0").bind(row.tenant_id,stamp,row.tenant_id).run();
    }
  }
  return {imported};
}

/** Loopback host uses the same policy/config APIs as Worker, retaining its SDK and chat archive. */
export function createLocalFlowRuntime({db,privateDir,codeKey,fetchImpl=fetch,copilotFactory=createFlowCopilot,identity,loadData}={}) {
  if(!path.isAbsolute(privateDir||'')||!db||!codeKey)throw new TypeError('Local Flow runtime configuration is incomplete');
  const env={DB:db,STORE_CODE_KEY:codeKey,LOCAL_TEST:'1',PUBLIC_ORIGIN:''};
  const archive=createFlowArchive({privateDir}),clients=new Map(),tasks=new Set();let disposed=false;
  const ctx={waitUntil(promise){const pending=Promise.resolve(promise).catch(()=>{});tasks.add(pending);pending.finally(()=>tasks.delete(pending));}};
  const sharedStore=()=>Object.assign(createFlowStore(env),archive);
  async function handle(request) {
    if(disposed)return Response.json({error:'本地预览已停止。'},{status:503});
    const url=new URL(request.url);
    if(!['localhost','127.0.0.1'].includes(url.hostname)||url.protocol!=='http:')return Response.json({error:'仅用于本地预览。'},{status:403});
    const store=sharedStore(),provider=createFlowProvider({store,fetchImpl});
    const platform=await handlePlatformFlow(request,env,ctx,{store,provider,...(identity?{identity}:{})});
    if(platform)return platform;
    const localProvider={...provider,async chat(options) {
      options.signal?.throwIfAborted();
      const connection=await store.getConnection(options.principal),token=connection?.data.githubToken;
      if(!safeToken(token))throw Object.assign(new Error('Flow 尚未配置，请联系平台。'),{status:409});
      const tenant=hash(flowConnectionScope(options.principal)),key=tenant+':'+hash(token);
      if(!clients.has(key))clients.set(key,copilotFactory({privateDir:path.join(privateDir,'flow-runtime-tenants',tenant,hash(token).slice(0,24)),gitHubToken:token,useLoggedInUser:false}));
      return clients.get(key).chat(options);
    }};
    return handleFlow(request,env,ctx,{store,provider:localProvider,...(identity?{identity}:{}),...(loadData?{loadData}:{})});
  }
  async function dispose() {disposed=true;await Promise.allSettled([...clients.values()].map(client=>client.dispose()));await Promise.allSettled([...tasks]);clients.clear();}
  return {handle,dispose,importConnections:()=>importLocalFlowConnections({db,privateDir,store:sharedStore()})};
}
