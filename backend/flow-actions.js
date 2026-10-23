import {executeCommand,previewCommand} from './repository.js';
import {ensureMaster,accountMutationGuard} from './accounts.js';
import {getFlowPolicy} from './flow-control.js';
import {assertFlowPrincipal} from '../scripts/flow-data.mjs';
import {PREFECTURES,getMunicipalities,getWards,resolveJapanAddress} from '../japan-addresses.js';
import {validateFlowArguments} from './flow-schema.js';

export const FLOW_REQUEST_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status,publicError:true});};
const string=(description,maxLength=120)=>({type:'string',minLength:1,maxLength,description});
const id=description=>({...string(description,160),pattern:'^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'});
const optionalText=(description,maxLength=120)=>({type:'string',maxLength,description});
const unit={type:'string',enum:['箱','袋','瓶','罐','盒','桶','个','KG'],description:'售卖单位'};
const object=(properties,required=[])=>({type:'object',additionalProperties:false,properties,required});
const storeFields={name:string('门店名称'),prefectureCode:string('都道府县代码',2),municipalityCode:string('市区町村代码',5),wardCode:optionalText('行政区代码',5),addressDetail:string('街道、门牌及楼层',180),contact:string('联系人'),phone:string('联系电话',24)};
const definition=(name,label,description,properties,required)=>({name,label,description,parameters:object(properties,required)});
export const FLOW_WRITE_TOOLS = [
  definition('flow_import_attachment_rows','导入报价／库存','从用户上传资料准备批量变更；先搜索匹配商品、单位与门店。仅按用户聊天要求导入销售报价或实物总库存，采购成本不能当销售价。每行必须引用本轮附件 ID 和页码／工作表位置。最多 20 行，先生成前后对照卡，点击确认才原子保存。',{rows:{type:'array',minItems:1,maxItems:20,description:'已核对的导入行',items:object({kind:{type:'string',enum:['quote','stock']},attachmentId:string('本轮附件 ID',36),sourceLocation:string('附件页码／工作表及行号',160),productId:id('商品 ID'),unit,storeId:id('门店 ID'),price:{type:'number',minimum:0},quantity:{type:'number',minimum:0},taxBasis:{type:'string',enum:['unspecified','inclusive','exclusive']},taxRate:{type:'number',minimum:0,maximum:1}},['kind','attachmentId','sourceLocation','productId','unit'])}},['rows']),
  definition('flow_create_store','新增门店','根据用户明确提供的资料真实新增门店。先用 flow_find_address 确认地区代码；缺少名称、联系人、电话或详细地址时先问用户，不能编造。负责人登录由系统开通，工具不返回负责人码。',storeFields,['name','prefectureCode','municipalityCode','addressDetail','contact','phone']),
  definition('flow_update_store','修改门店','修改已查询确认的本厨房门店，仅更改用户指定的资料字段。不能更改身份、负责人码或图片。',{storeId:id('门店 ID'),changes:{...object({...storeFields,contact:optionalText('联系人'),phone:optionalText('联系电话',24),address:optionalText('完整地址',500),addressDetail:optionalText('详细地址',500)}),minProperties:1}},['storeId','changes']),
  definition('flow_create_product','新增商品','真实新增商品；名称、类目、单位需由用户确定。未提供单价或库存时保持未设置，不填零，也不从成本推算价格。',{name:string('商品名称'),category:string('商品类目'),unit,spec:optionalText('规格',200),description:optionalText('商品说明',4000),basePrice:{type:'number',minimum:0,description:'明确指定的初始销售单价（日元）'},stock:{type:'number',minimum:0,description:'明确指定的初始库存'}},['name','category','unit']),
  definition('flow_set_stock','更新库存','按用户明确给出的盘点结果设置实物总库存，数量为设置后的总量，不是增减量。先查询商品与当前单位换算，不得推断库存数量。',{productId:id('商品 ID'),unit,quantity:{type:'number',minimum:0,description:'盘点后的实物总库存'}},['productId','unit','quantity']),
  definition('flow_set_quote','更新报价','设置已查询确认的门店、商品和单位的销售报价，仅作用于新订单。单价和税口径必须由用户明确给出；未知税口径使用 unspecified，不臆造税率。',{storeId:id('门店 ID'),productId:id('商品 ID'),unit,price:{type:'number',minimum:0,description:'销售单价（日元）'},taxBasis:{type:'string',enum:['unspecified','exclusive','inclusive'],description:'税口径'},taxRate:{type:'number',minimum:0,maximum:1,description:'明确的税率小数，例如 0.08'}},['storeId','productId','unit','price','taxBasis']),
  definition('flow_create_task','新增手动待办','将用户主动提出的事项写入本厨房共享的手动待办。截止日期需明确或由用户的相对日期换算为日本日期；不得根据业务异常擅自重复创建系统待办。',{title:string('待办标题'),note:optionalText('备注',500),dueDate:string('截止日期 YYYY-MM-DD',10)},['title','dueDate']),
  definition('flow_set_task_done','更新待办状态','完成或恢复已查询确认的手动待办，不影响订单、缺货异常或系统待办。',{taskId:id('手动待办 ID'),done:{type:'boolean',description:'是否完成'}},['taskId','done']),
  definition('flow_set_task_deadline','修改待办期限','修改已查询确认的手动待办截止日期，保留其他资料和完成状态。',{taskId:id('手动待办 ID'),dueDate:string('截止日期 YYYY-MM-DD',10)},['taskId','dueDate']),
  definition('flow_delete_store','删除门店','准备删除用户明确指定且已查询确认的门店。确认后停用门店登录、释放未用配额，保留订单、单据和报价历史。',{storeId:id('门店 ID')},['storeId']),
  definition('flow_delete_product','删除商品','准备将已查询确认的商品移入回收站，历史订单保留。',{productId:id('商品 ID')},['productId']),
  definition('flow_restore_product','恢复商品','准备从回收站恢复已查询确认的商品。',{productId:id('商品 ID')},['productId']),
  definition('flow_delete_task','删除手动待办','准备删除已查询确认的手动待办；不能删除系统待办或消除业务异常。',{taskId:id('手动待办 ID')},['taskId']),
  definition('flow_restore_task','恢复手动待办','准备恢复已删除的手动待办，保留原来的完成状态。',{taskId:id('手动待办 ID')},['taskId']),
];
for(const tool of FLOW_WRITE_TOOLS)tool.description+=' 此工具只准备操作，不保存业务数据。返回确认卡片后请用户点击确认；不能通过聊天文字或工具参数代替用户确认。';
const writes=new Map(FLOW_WRITE_TOOLS.map(tool=>[tool.name,tool]));
export const isFlowWriteTool=name=>writes.has(name);
export const FLOW_ADDRESS_TOOL=definition('flow_find_address','核对门店地址','从站内日本行政区数据查地区代码，支持名称或名称前缀。先指定都道府县再查询市区町村、行政区；不搜索外网，不补造街道门牌。',{prefecture:optionalText('都道府县名称或代码'),municipality:optionalText('市区町村名称或代码'),ward:optionalText('行政区名称或代码')},[]);
export function findFlowAddresses(args) {
  validateFlowArguments(FLOW_ADDRESS_TOOL.parameters,args);
  const matches=(row,value)=>!value||row.code===value.trim()||row.name.includes(value.trim());
  const prefectures=PREFECTURES.filter(row=>matches(row,args.prefecture));
  const results=[];
  for(const prefecture of prefectures) {
    if(!args.municipality&&!args.ward){results.push({prefecture:prefecture.name,prefectureCode:prefecture.code});continue;}
    for(const municipality of getMunicipalities(prefecture.code).filter(row=>matches(row,args.municipality))) {
      const wards=getWards(prefecture.code,municipality.code);
      if(!wards.length&&!args.ward)results.push({prefecture:prefecture.name,prefectureCode:prefecture.code,municipality:municipality.name,municipalityCode:municipality.code,ward:'',wardCode:''});
      for(const ward of wards.filter(row=>matches(row,args.ward)))results.push({prefecture:prefecture.name,prefectureCode:prefecture.code,municipality:municipality.name,municipalityCode:municipality.code,ward:ward.name,wardCode:ward.code});
    }
  }
  return {data:{total:results.length,results:results.slice(0,30),truncated:results.length>30},sources:[]};
}
const canonical=value=>value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');
const pick=(row,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(row||{},key)).map(key=>[key,row[key]]));

export function createFlowActions({request,env,principal,requestId,data,attachmentRecords=[],checkAccess,readPolicy=()=>getFlowPolicy(env,principal.tenantId),onMutation=()=>{},onProposal=()=>{}}) {
  assertFlowPrincipal(principal);
  if(!principal.userId||!['owner','member'].includes(principal.accountRole)||typeof requestId!=='string'||!FLOW_REQUEST_ID.test(requestId))fail('请刷新页面后重新发送操作。',400);
  const db=env.DB,prefix=`flow:${requestId}:`;
  let prior,recovery=false,writeCount=0;
  const preparedKeys=new Set();
  async function previous() {
    if(!prior) {
      const rows=await db.prepare('SELECT c.request_key,c.result_json,c.revision,b.entity_id FROM command_idempotency c LEFT JOIN business_audit_log b ON b.tenant_id=c.tenant_id AND b.user_id=c.user_id AND b.revision=c.revision WHERE c.tenant_id=? AND c.user_id=? AND c.request_key LIKE ? ORDER BY c.revision LIMIT 7').bind(principal.tenantId,principal.userId,prefix+'%').all();
      prior=rows.results||[];
      if(prior.length>6)fail('这条消息的操作记录超过上限，请新建消息核对。',409);
      recovery=prior.length>0;
    }
    return prior;
  }
  async function receipt(name,result,key,revision,replayed=false) {
    const recordId=typeof result?.id==='string'?result.id:'';
    const recordLabel=String(result?.name||result?.title||writes.get(name)?.label||'业务记录').slice(0,160);
    const page=name.includes('store')||name==='flow_set_quote'?'stores':name.includes('task')?'tasks':'catalogue';
    const query=new URLSearchParams({page});
    if(page==='stores'){query.set('tab',name==='flow_set_quote'?'quotes':'stores');if(recordId)query.set('store',recordId);}
    if(page==='catalogue'&&recordId)query.set('product',recordId);
    if(page==='tasks')query.set('tab','manual');
    let status='saved';
    if(name==='flow_create_store') {
      const account=await db.prepare("SELECT a.id FROM staff_accounts a JOIN account_keys k ON k.account_id=a.id WHERE a.tenant_id=? AND a.store_id=? AND a.role='store' AND a.account_role='owner' AND a.status='active'").bind(principal.tenantId,recordId).first();
      if(!account)status='pending_account';
    }
    return {id:key,operation:name,label:writes.get(name).label,recordId,recordLabel,href:'/?'+query.toString(),revision,status,replayed};
  }
  async function receipts() {
    await checkAccess();
    const result=[];
    for(const row of await previous()) {
      const name=row.request_key.slice(prefix.length).split(':')[0];
      if(writes.has(name)) {
        let record=JSON.parse(row.result_json);
        if(name==='flow_set_stock'||name==='flow_set_quote')record=pick(data.snapshot.state[name==='flow_set_quote'?'stores':'products'].find(item=>item.id===row.entity_id)||{id:row.entity_id},['id','name']);
        let item=await receipt(name,record,row.request_key,row.revision,true);
        if(item.status==='pending_account') {
          onMutation(item);await checkAccess();
          try{await ensureMaster(db,env,principal.tenantId,item.recordId,{}, {includeCode:false});}
          catch{throw Object.assign(new Error('门店已保存，负责人登录仍未开通，请稍后重试。'),{status:503,publicError:true,flowSaved:true});}
          item={...item,status:'saved'};
        }
        result.push(item);
      }
    }
    return result;
  }
  function commandFor(name,args) {
    const state=data.snapshot.state;
    const active=(kind,id)=>{
      const row=(state[kind]||[]).find(row=>row.id===id&&!row.deletedAt);
      if(!row)fail('当前厨房中未找到该记录，或记录已删除。',404);
      return row;
    };
    if(name==='flow_import_attachment_rows') {
      const rows=args.rows.map(row=>{
        const source=attachmentRecords.find(doc=>doc.id===row.attachmentId);
        if(!source||!source.parts.some(part=>row.sourceLocation===part.label||row.sourceLocation.startsWith(part.label+' ')||row.sourceLocation.startsWith(part.label+' ·')||row.sourceLocation.startsWith(part.label+'，')))fail('导入来源必须引用本轮附件中的页码或工作表。');
        active('products',row.productId);
        if(row.kind==='quote'){if(!row.storeId||row.price===undefined||!row.taxBasis||row.quantity!==undefined)fail('报价行需指定门店、销售单价和税口径。');active('stores',row.storeId);return {type:'setUnitQuote',args:[row.storeId,row.productId,row.unit,row.price,row.taxBasis,row.taxRate??null]};}
        if(row.quantity===undefined||row.price!==undefined||row.storeId!==undefined||row.taxBasis!==undefined||row.taxRate!==undefined)fail('库存行只填写实物总数量和单位。');
        return {type:'setWarehouseUnitStock',args:[row.productId,row.unit,row.quantity]};
      });return {type:'applyAttachmentRows',args:[rows]};
    }
    if(name==='flow_create_store') {
      const parts=resolveJapanAddress(args),address=[parts.prefecture,parts.municipality,parts.ward,args.addressDetail.trim()].join('');
      if(state.stores.some(row=>!row.deletedAt&&row.name?.trim()===args.name.trim()&&row.address===address))fail('已存在同名同地址门店，请查看现有记录。',409);
      return {type:'addStore',args:[args]};
    }
    if(name==='flow_update_store'){
      const current=active('stores',args.storeId),changes={...args.changes};
      if(['addressDetail','prefectureCode','municipalityCode','wardCode'].some(key=>Object.hasOwn(changes,key))) {
        if(!current.prefectureCode&&!changes.prefectureCode&&!Object.hasOwn(changes,'address'))fail('这家门店尚未设置行政区，请同时提供完整地址或补全行政区。');
        if(current.prefectureCode||changes.prefectureCode)for(const key of ['prefectureCode','municipalityCode','wardCode','addressDetail'])if(!Object.hasOwn(changes,key))changes[key]=current[key]||'';
      }
      return {type:'updateStore',args:[args.storeId,changes]};
    }
    if(name==='flow_create_product')return {type:'addProduct',args:[args]};
    if(name==='flow_set_stock'){active('products',args.productId);return {type:'setWarehouseUnitStock',args:[args.productId,args.unit,args.quantity]};}
    if(name==='flow_set_quote'){active('products',args.productId);active('stores',args.storeId);return {type:'setUnitQuote',args:[args.storeId,args.productId,args.unit,args.price,args.taxBasis,args.taxRate??null]};}
    if(name==='flow_create_task')return {type:'addManualTask',args:[args]};
    const lifecycle={flow_delete_store:['stores','storeId','deleteStore'],flow_delete_product:['products','productId','deleteProduct'],flow_restore_product:['products','productId','restoreProduct'],flow_delete_task:['manualTasks','taskId','deleteManualTask'],flow_restore_task:['manualTasks','taskId','restoreManualTask']}[name];
    if(lifecycle) {
      const [kind,key,type]=lifecycle,row=(state[kind]||[]).find(row=>row.id===args[key]);
      if(!row||Boolean(row.deletedAt)!==name.includes('_restore_'))fail('未找到符合状态的记录，请重新查询。',409);
      return {type,args:[args[key]]};
    }
    active('manualTasks',args.taskId);
    return name==='flow_set_task_done'?{type:'setManualTaskDone',args:[args.taskId,args.done]}:{type:'setManualTaskDueDate',args:[args.taskId,args.dueDate]};
  }
  async function commit(name,args,proposal) {
    const tool=writes.get(name);if(!tool)fail('这项写入操作尚未开放。');
    validateFlowArguments(tool.parameters,args);
    await checkAccess();
    const key=prefix+name+':'+await digest(canonical(args));
    const old=await previous();
    if(data.stale)await data.reload();
    if(!Number.isSafeInteger(data.index?.revision))fail('尚未取得完整业务资料，请重试。',409);
    const command=JSON.parse(proposal.command_json);
    const policy=await readPolicy();
    if(!policy.enabled)fail('Flow 已停用，请联系平台。',403);
    if(policy.version!==proposal.policy_version)fail('Flow 配置已变更，请重新发送请求。',409);
    const guard=await accountMutationGuard(request,env,principal);
    guard.sql+=" AND EXISTS(SELECT 1 FROM tenant_features WHERE tenant_id=? AND flow_enabled=1 AND version=?)";
    guard.params.push(principal.tenantId,policy.version);
    guard.sql+=" AND EXISTS(SELECT 1 FROM flow_proposals WHERE id=? AND tenant_id=? AND user_id=? AND status='pending' AND expires_at>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))";
    guard.params.push(proposal.id,principal.tenantId,principal.userId);
    const saved=await executeCommand(db,principal,{...command,idempotencyKey:key},{expectedRevision:data.index.revision,writeGuard:guard,beforeCommit:checkAccess,
      commitStatements:[db.prepare("UPDATE flow_proposals SET status='saved' WHERE id=? AND tenant_id=? AND user_id=? AND status='pending'").bind(proposal.id,principal.tenantId,principal.userId)]});
    if(!old.some(row=>row.request_key===key))old.push({request_key:key,result_json:JSON.stringify(saved.result),revision:saved.revision,entity_id:name==='flow_set_quote'?args.storeId:args.productId||args.storeId});
    data.stale=true;
    let record=saved.result;
    if(name==='flow_set_stock')record=pick(saved.state.products.find(row=>row.id===args.productId),['id','name']);
    if(name==='flow_set_quote')record=pick(saved.state.stores.find(row=>row.id===args.storeId),['id','name']);
    let mutation=await receipt(name,record,key,saved.revision,saved.replayed);
    onMutation(mutation);
    if(name==='flow_create_store') {
      try {
        await checkAccess();
        // The account module alone handles credentials. Never return its result
        // to the model, event stream, conversation, or business audit payload.
        await ensureMaster(db,env,principal.tenantId,saved.result.id,{}, {includeCode:false});
      } catch(error) {
        if([401,403].includes(error.status))throw error;
        throw Object.assign(new Error('门店资料已保存，负责人登录尚未开通。请重试完成开通，不会重复新增门店。'),{status:503,publicError:true,flowSaved:true});
      }
      mutation={...mutation,status:'saved'};onMutation(mutation);
    }
    let refreshRequired=false;
    try {await data.reload();}catch{refreshRequired=true;}
    const kind=name.includes('store')||name==='flow_set_quote'?'store':name.includes('task')?'task':'product';
    const source={kind,recordId:mutation.recordId,label:mutation.recordLabel,href:mutation.href};
    return {data:{saved:true,replayed:saved.replayed,refreshRequired,revision:saved.revision,
      record:pick(record,['id','name','title','unit','spec','basePrice','stock','address','contact','phone','dueDate','done','completedAt']),source,
      ...(name==='flow_set_stock'?{quantity:args.quantity,unit:args.unit}:{}),
      ...(name==='flow_set_quote'?{storeId:args.storeId,productId:args.productId,unit:args.unit,price:args.price,taxBasis:args.taxBasis,taxRate:args.taxRate??null}:{})},
      sources:[{id:mutation.recordId,type:kind,title:mutation.recordLabel,url:mutation.href}],mutation};
  }
  function publicProposal(row) {
    return {id:row.id,requestId:row.request_id,operation:row.operation,...JSON.parse(row.review_json),status:row.status==='pending'&&row.expires_at<=Date.now()?'expired':row.status};
  }
  async function proposals() {
    await checkAccess();
    const result=await db.prepare('SELECT * FROM flow_proposals WHERE tenant_id=? AND user_id=? AND request_id=? ORDER BY created_at,id').bind(principal.tenantId,principal.userId,requestId).all();
    return result.results.map(publicProposal);
  }
  function review(name,args,result) {
    if(name==='flow_import_attachment_rows') {
      const value=n=>n==null?'未设置':String(n);
      return {label:'导入报价／库存',recordLabel:result.name,impact:'确认后整批保存；任一行失败时整批不保存。报价仅用于新订单，历史成交价保留。库存为实物总量。',details:result.rows.map((row,index)=>({label:`${index+1}. ${row.productName} · ${row.unit}`,value:[row.spec?`规格：${row.spec}`:'',row.kind==='quote'?`门店：${row.storeName}\n销售单价：${value(row.before)} → ${value(row.after)} 日元\n税口径：${({unspecified:'未设置',inclusive:'含税',exclusive:'未税'})[row.taxBasis]}${row.taxRate==null?' · 税率未设置':' · '+row.taxRate*100+'%'}`:`实物总库存：${value(row.before)} → ${value(row.after)} ${row.unit}`,`来源：${attachmentRecords.find(doc=>doc.id===args.rows[index].attachmentId).name} · ${args.rows[index].sourceLocation}`].filter(Boolean).join('\n')}))};
    }
    const details=[],add=(label,value)=>{if(value!==undefined&&value!==null&&value!=='')details.push({label,value:String(value)});};
    const labels={name:'名称',category:'类目',unit:'单位',spec:'规格',description:'说明',basePrice:'销售单价（日元）',stock:'库存',contact:'联系人',phone:'电话',title:'事项',note:'备注',dueDate:'截止日期',quantity:'实物总库存',price:'销售单价（日元）',taxRate:'税率'};
    const values=args.changes||args;
    for(const [key,label] of Object.entries(labels))add(label,values[key]===''?'（清空）':values[key]);
    if(name.includes('_delete_')||name.includes('_restore_'))for(const key of ['category','spec','unit','contact','phone','note','dueDate'])add(labels[key],result?.[key]);
    if(name.includes('store'))add('地址',result?.address);
    if(args.productId)add('商品',data.snapshot.state.products.find(row=>row.id===args.productId)?.name);
    if(args.storeId)add('门店',data.snapshot.state.stores.find(row=>row.id===args.storeId)?.name);
    if(args.taskId)add('待办',data.snapshot.state.manualTasks?.find(row=>row.id===args.taskId)?.title);
    if(args.taxBasis)add('税口径',({unspecified:'未设置',inclusive:'含税',exclusive:'未税'})[args.taxBasis]);
    if(typeof args.done==='boolean')add('状态',args.done?'已完成':'未完成');
    if(name==='flow_create_product'){if(args.basePrice===undefined)add('销售单价','未设置');if(args.stock===undefined)add('库存','未设置');}
    const impact=({flow_delete_store:'确认后该门店无法登录或继续订货，未用配额释放；已有订单、单据及报价历史保留。',flow_delete_product:'确认后商品移入回收站，不再用于新订单；历史订单保留，可恢复。',flow_restore_product:'确认后商品恢复使用，原有报价与资料保留。',flow_delete_task:'确认后从手动待办列表移除，可恢复；不改变订单或系统异常。',flow_restore_task:'确认后回到手动待办列表，保留原完成状态。'})[name]||'确认后保存到当前厨房。';
    return {label:writes.get(name).label,recordLabel:String(result?.name||result?.title||details.find(row=>['商品','门店','待办'].includes(row.label))?.value||writes.get(name).label).slice(0,160),details,impact};
  }
  async function execute(name,args) {
    const tool=writes.get(name);if(!tool)fail('这项写入操作尚未开放。');
    validateFlowArguments(tool.parameters,args);await checkAccess();
    if(++writeCount>6)fail('本轮最多准备 6 项操作，请分批处理。');
    const key=prefix+name+':'+await digest(canonical(args));
    const old=await db.prepare('SELECT * FROM flow_proposals WHERE tenant_id=? AND user_id=? AND request_key=?').bind(principal.tenantId,principal.userId,key).first();
    if(old){const proposal=publicProposal(old);onProposal(proposal);return {data:{saved:old.status==='saved',requiresConfirmation:proposal.status==='pending',proposal},sources:[]};}
    const existing=await proposals();await previous();
    if(recovery||existing.some(row=>row.status!=='pending'||!preparedKeys.has(row.id)))fail('这条请求已有处理结果。后续操作请发送新消息。',409);
    if(existing.length>=6)fail('本轮最多准备 6 项操作，请分批处理。');
    if(data.stale)await data.reload();
    const command=commandFor(name,args),result=previewCommand(data.snapshot.state,principal,{...command,idempotencyKey:key});
    const policy=await readPolicy();if(!policy.enabled)fail('Flow 已停用。',403);
    const id=crypto.randomUUID(),now=Date.now(),reviewJson=JSON.stringify(review(name,args,result));
    await checkAccess();
    await db.prepare("INSERT INTO flow_proposals(id,tenant_id,user_id,request_id,request_key,operation,args_json,command_json,review_json,revision,account_version,policy_version,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?) ON CONFLICT(tenant_id,user_id,request_key) DO NOTHING").bind(id,principal.tenantId,principal.userId,requestId,key,name,JSON.stringify(args),JSON.stringify(command),reviewJson,data.index.revision,principal.version,policy.version,now,now+1800000).run();
    const row=await db.prepare('SELECT * FROM flow_proposals WHERE tenant_id=? AND user_id=? AND request_key=?').bind(principal.tenantId,principal.userId,key).first(),proposal=publicProposal(row);
    preparedKeys.add(proposal.id);onProposal(proposal);return {data:{saved:false,requiresConfirmation:true,proposal},sources:[]};
  }
  async function resolve(id,decision) {
    if(!FLOW_REQUEST_ID.test(id)||!['confirm','cancel'].includes(decision))fail('操作确认格式不正确。');
    await checkAccess();
    const row=await db.prepare('SELECT * FROM flow_proposals WHERE id=? AND tenant_id=? AND user_id=? AND request_id=?').bind(id,principal.tenantId,principal.userId,requestId).first();
    if(!row)fail('未找到该待确认操作。',404);
    if(row.status==='saved')return {proposal:publicProposal(row),mutations:await receipts()};
    if(row.status==='cancelled')return {proposal:publicProposal(row),mutations:[]};
    if(decision==='cancel') {
      await db.prepare("UPDATE flow_proposals SET status='cancelled' WHERE id=? AND tenant_id=? AND user_id=? AND status='pending'").bind(id,principal.tenantId,principal.userId).run();
      const latest=await db.prepare('SELECT * FROM flow_proposals WHERE id=? AND tenant_id=? AND user_id=?').bind(id,principal.tenantId,principal.userId).first();
      return {proposal:publicProposal(latest),mutations:latest.status==='saved'?await receipts():[]};
    }
    if(row.expires_at<=Date.now())fail('确认已过期，请重新发送请求。',409);
    const policy=await readPolicy();
    if(row.account_version!==principal.version||row.policy_version!==policy.version)fail('账号或 Flow 配置已变更，请重新发送请求。',409);
    await data.reload();
    // Allow other confirmed items from this same request, but never silently
    // accept intervening edits by a person or a different Flow request.
    const intervening=await db.prepare("SELECT COUNT(*) AS n FROM command_idempotency c JOIN flow_proposals p ON p.tenant_id=c.tenant_id AND p.user_id=c.user_id AND p.request_key=c.request_key WHERE c.tenant_id=? AND c.user_id=? AND p.request_id=? AND p.status='saved' AND c.revision>? AND c.revision<=?").bind(principal.tenantId,principal.userId,requestId,row.revision,data.index.revision).first();
    if(data.index.revision-row.revision!==intervening.n)fail('业务资料已更新，请重新发送请求，核对后再确认。',409);
    await commit(row.operation,JSON.parse(row.args_json),row);
    return {proposal:publicProposal({...row,status:'saved'}),mutations:await receipts()};
  }
  return {execute,receipts,proposals,resolve};
}
