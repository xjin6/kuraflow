import {createFlowDataTools, loadFlowSnapshot, FLOW_DATA_TOOL_DEFINITIONS} from '../scripts/flow-data.mjs';

export const flowToolDefinitions = FLOW_DATA_TOOL_DEFINITIONS;
export async function createFlowDataContext(db, principal) {
  const snapshot=await loadFlowSnapshot(db,principal), state=snapshot.state;
  const tools=createFlowDataTools({db,principal,loadSnapshot:async()=>snapshot});
  const quotes=await tools.execute('flow_search',{kind:'quote',limit:1,includeDeleted:true});
  return {tools,index:{products:state.products.length,stores:state.stores.length,orders:state.orders.length,documents:state.documents.length,quotes:quotes.total,updatedAt:snapshot.capturedAt,complete:snapshot.complete,revision:snapshot.revision}};
}
export async function runFlowTool(context,name,args) {
  if(!args || typeof args!=='object' || Array.isArray(args))throw new Error('查询参数不正确。');
  const definition=flowToolDefinitions.find(tool=>tool.name===name);
  if(!definition)throw new Error('不支持这项查询。');
  const properties=definition.parameters.properties;
  for(const [key,value] of Object.entries(args)){
    const schema=properties[key];
    if(!schema)throw new Error('不支持这个查询字段。');
    if(schema.type==='boolean'&&typeof value!=='boolean'||schema.type==='string'&&typeof value!=='string'||schema.type==='integer'&&!Number.isInteger(value)||schema.type==='number'&&(typeof value!=='number'||!Number.isFinite(value)))throw new Error('查询参数类型不正确。');
  }
  const data=await context.tools.execute(name,args), entries=[];
  if(data.source)entries.push(data.source);
  for(const row of [...(data.results||[]),...(data.byStore||[])])if(row.source)entries.push(row.source);
  const sources=entries.slice(0,30).map(source=>({id:source.recordId||source.id,type:source.kind,title:source.label,url:source.href}));
  return {data,sources};
}
