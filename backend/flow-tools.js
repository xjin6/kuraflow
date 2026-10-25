import {createFlowDataTools, loadFlowSnapshot, FLOW_DATA_TOOL_DEFINITIONS} from '../src/shared/flow-data.mjs';
import {validateFlowArguments} from './flow-schema.js';

export const flowToolDefinitions = FLOW_DATA_TOOL_DEFINITIONS;
export async function createFlowDataContext(db, principal) {
  const context={stale:true,async reload() {
    context.stale=true;
    const snapshot=await loadFlowSnapshot(db,principal),state=snapshot.state;
    const tools=createFlowDataTools({db,principal,loadSnapshot:async()=>snapshot});
    const quotes=await tools.execute('flow_search',{kind:'quote',limit:1,includeDeleted:true});
    Object.assign(context,{snapshot,tools,stale:false,index:{products:state.products.length,stores:state.stores.length,orders:state.orders.length,documents:state.documents.length,quotes:quotes.total,updatedAt:snapshot.capturedAt,complete:snapshot.complete,revision:snapshot.revision}});
  }};
  await context.reload();return context;
}
export async function runFlowTool(context,name,args) {
  if(!args || typeof args!=='object' || Array.isArray(args))throw new Error('查询参数不正确。');
  const definition=flowToolDefinitions.find(tool=>tool.name===name);
  if(!definition)throw new Error('不支持这项查询。');
  validateFlowArguments(definition.parameters,args);
  if(context.stale)await context.reload();
  const data=await context.tools.execute(name,args), entries=[];
  if(data.source)entries.push(data.source);
  for(const row of [...(data.results||[]),...(data.byStore||[])])if(row.source)entries.push(row.source);
  const sources=entries.slice(0,30).map(source=>({id:source.recordId||source.id,type:source.kind,title:source.label,url:source.href}));
  return {data,sources};
}
