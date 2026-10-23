export const FLOW_ATTACHMENT_LIMITS = Object.freeze({files:3, fileBytes:10*1024*1024, pages:20, images:6, text:60000, payloadBytes:1500000});
export const FLOW_ATTACHMENT_ACCEPT = '.pdf,.xlsx,.csv,.tsv,.txt,.png,.jpg,.jpeg,.webp';
export const attachmentId = value => typeof value==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function cleanAttachmentRefs(value=[]) {
  if(!Array.isArray(value)||value.length>FLOW_ATTACHMENT_LIMITS.files)throw Object.assign(new Error('每条消息最多添加 3 个附件。'),{status:400,publicError:true});
  const seen=new Set();
  return value.map(row=>{
    if(!attachmentId(row?.id)||seen.has(row.id))throw Object.assign(new Error('附件编号不正确。'),{status:400,publicError:true});seen.add(row.id);
    return {id:row.id,name:String(row.name||'附件').slice(0,160),kind:['pdf','spreadsheet','image','text'].includes(row.kind)?row.kind:'text',pages:Number.isSafeInteger(row.pages)&&row.pages>0?row.pages:1};
  });
}
