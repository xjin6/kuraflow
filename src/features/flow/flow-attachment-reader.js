import {unzipSync,strFromU8} from 'fflate';
import {FLOW_ATTACHMENT_LIMITS as limits} from '../../shared/flow-attachment-data.js';
const error=message=>{throw new Error(message);};
const checkedText=text=>{if(text.length>limits.text)error('文件文字超过 6 万字，请拆分后上传。');return text;};
function xml(bytes){
  if(!bytes)error('Excel 文件结构不完整。');const text=strFromU8(bytes);
  if(/<!DOCTYPE|<!ENTITY/i.test(text))error('不支持含外部实体的表格。');
  const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.querySelector('parsererror'))error('Excel 文件无法读取。');return doc;
}
export function readWorkbook(bytes){
  let total=0;
  const files=unzipSync(bytes,{filter:entry=>{if(entry.originalSize>2000000||(total+=entry.originalSize)>8000000)error('表格解压后过大，请拆分文件。');return /^(xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml))$/.test(entry.name);}});
  const shared=files['xl/sharedStrings.xml']?[...xml(files['xl/sharedStrings.xml']).querySelectorAll('si')].map(n=>[...n.querySelectorAll('t')].map(t=>t.textContent).join('')):[];
  const rels=new Map([...xml(files['xl/_rels/workbook.xml.rels']).querySelectorAll('Relationship')].filter(n=>n.getAttribute('TargetMode')!=='External').map(n=>[n.getAttribute('Id'),n.getAttribute('Target')]));
  const sheets=[...xml(files['xl/workbook.xml']).querySelectorAll('sheet')];if(sheets.length>limits.pages)error('每份文件最多 20 个工作表。');let chars=0;
  return sheets.map((sheet,index)=>{
    const target=rels.get(sheet.getAttribute('r:id')),file=target?.startsWith('/xl/')?target.slice(1):'xl/'+target;
    if(!/^xl\/worksheets\/sheet\d+\.xml$/.test(file))error('此工作表格式暂不支持。');
    const rows=[...xml(files[file]).querySelectorAll('sheetData > row')];if(rows.length>5000)error('单个工作表最多 5000 行，请拆分。');
    const lines=rows.map((row,i)=>{
      const cells=[...row.querySelectorAll('c')];if(cells.length>80)error('表格列数过多。');
      return `行 ${row.getAttribute('r')||i+1}: `+cells.map(cell=>{
        const value=cell.querySelector('v')?.textContent||'',type=cell.getAttribute('t');
        const text=type==='s'?shared[Number(value)]??'':type==='inlineStr'?[...cell.querySelectorAll('is t')].map(n=>n.textContent).join(''):cell.querySelector('f')&&!value?'[公式无已保存结果]':value;
        return `${cell.getAttribute('r')||''}=${text}`;
      }).join(' | ');
    }).join('\n');chars+=lines.length;if(chars>limits.text)error('表格内容过多，请拆分文件。');
    return {label:`工作表 ${index+1} · ${sheet.getAttribute('name')||index+1}`,text:lines||'（空工作表）'};
  });
}
function decodeText(bytes){try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return new TextDecoder('shift-jis',{fatal:true}).decode(bytes);}}
export function readDelimited(text,delimiter=','){
  const rows=[],row=[];let cell='',quoted=false;
  const finish=()=>{row.push(cell);cell='';if(row.length>80)error('表格列数过多。');};
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else if(quoted||!cell)quoted=!quoted;else cell+=c;}else if(!quoted&&c===delimiter)finish();else if(!quoted&&(c==='\n'||c==='\r')){if(c==='\r'&&text[i+1]==='\n')i++;finish();rows.push(row.splice(0));if(rows.length>5000)error('表格行数过多，请拆分文件。');}else cell+=c;}
  if(quoted)error('表格引号未闭合，请检查文件。');if(cell||row.length){finish();rows.push(row);}
  return checkedText(rows.map((r,i)=>`行 ${i+1}: ${r.join(' | ')}`).join('\n'));
}
function jpeg(canvas){
  let quality=.86,result='';
  for(let attempt=0;attempt<12;attempt++){
    result=canvas.toDataURL('image/jpeg',quality).split(',')[1];if(result.length<=290000)return {mimeType:'image/jpeg',data:result};
    if(quality>.5)quality-=.12;else{const small=document.createElement('canvas');small.width=Math.max(1,Math.floor(canvas.width*.8));small.height=Math.max(1,Math.floor(canvas.height*.8));small.getContext('2d').drawImage(canvas,0,0,small.width,small.height);canvas=small;}
  }error('图片过大，请裁剪后上传。');
}
async function readImage(file,signal){
  const url=URL.createObjectURL(file),image=new Image();
  try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('图片无法读取。'));image.src=url;});signal?.throwIfAborted();
    if(image.width*image.height>24000000)error('图片分辨率过大，请缩小后上传。');const scale=Math.min(1,1800/Math.max(image.width,image.height));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);return [{label:'图片 1',text:'',image:jpeg(canvas)}];
  }finally{URL.revokeObjectURL(url);}
}
async function readPDF(bytes,signal,onProgress){
  const url='/public/vendor/pdfjs/pdf.mjs',pdfjs=await import(url);pdfjs.GlobalWorkerOptions.workerSrc='/public/vendor/pdfjs/pdf.worker.min.mjs';
  const task=pdfjs.getDocument({data:bytes,isEvalSupported:false,useWasm:false,disableFontFace:true,useSystemFonts:true,cMapUrl:'/public/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/public/vendor/pdfjs/standard_fonts/'});
  const abort=()=>{task.destroy().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,60000);
  try{const pdf=await task.promise;if(pdf.numPages>limits.pages)error('PDF 最多支持 20 页，请拆分文件。');const parts=[];let chars=0,images=0;
    for(let number=1;number<=pdf.numPages;number++){
      signal?.throwIfAborted();onProgress(`正在读取第 ${number} / ${pdf.numPages} 页`);const page=await pdf.getPage(number),content=await page.getTextContent();
      if(content.items.length>20000)error('PDF 页面过于复杂，请拆分或导出为表格。');
      const lines=[];for(const item of content.items.filter(n=>n.str).sort((a,b)=>b.transform[5]-a.transform[5]||a.transform[4]-b.transform[4])){let line=lines.find(n=>Math.abs(n.y-item.transform[5])<3);if(!line){line={y:item.transform[5],items:[]};lines.push(line);}line.items.push(item);}
      const text=lines.map((line,i)=>`行 ${i+1}: `+line.items.sort((a,b)=>a.transform[4]-b.transform[4]).map(n=>n.str).join(' ')).join('\n');chars+=text.length;if(chars>limits.text)error('PDF 文字过多，请拆分文件。');
      const part={label:`第 ${number} 页`,text};const ops=text.length<500?await page.getOperatorList():null;
      if(text.trim().length<60||ops?.fnArray.some(n=>[pdfjs.OPS.paintImageXObject,pdfjs.OPS.paintInlineImageXObject].includes(n))){if(++images>limits.images)error('扫描件每份最多 6 页，请拆分后上传。');const natural=page.getViewport({scale:1}),scale=Math.min(2,1800/Math.max(natural.width,natural.height)),viewport=page.getViewport({scale}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);await page.render({canvasContext:canvas.getContext('2d'),viewport,background:'rgb(255,255,255)'}).promise;part.image=jpeg(canvas);}
      parts.push(part);page.cleanup();
    }return parts;
  }catch(failure){if(signal?.aborted)throw signal.reason;if(failure.name==='PasswordException')error('PDF 已加密，请先解锁再上传。');throw failure;
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);await task.destroy();}
}
export async function prepareFlowAttachment(file,{signal,onProgress=()=>{}}={}){
  if(!file?.size||file.size>limits.fileBytes)error('请选择不超过 10 MB 的文件。');if(file.name.length>160)error('文件名过长，请重命名。');const extension=file.name.split('.').at(-1).toLowerCase();let parts,kind;
  signal?.throwIfAborted();onProgress('正在读取文件…');
  if(['jpg','jpeg','png','webp'].includes(extension)){kind='image';parts=await readImage(file,signal);}else{
    const bytes=new Uint8Array(await file.arrayBuffer());signal?.throwIfAborted();
    if(extension==='pdf'){if(new TextDecoder().decode(bytes.slice(0,5))!=='%PDF-')error('文件不是有效的 PDF。');kind='pdf';parts=await readPDF(bytes,signal,onProgress);}
    else if(extension==='xlsx'){kind='spreadsheet';parts=readWorkbook(bytes);}
    else if(['csv','tsv','txt'].includes(extension)){kind=extension==='txt'?'text':'spreadsheet';const text=checkedText(decodeText(bytes));parts=[{label:'第 1 页',text:extension==='txt'?text:readDelimited(text,extension==='tsv'?'\t':',')}];}
    else error('请上传 PDF、Excel（xlsx）、CSV、TXT 或图片。');
  }
  if(!parts.length||parts.every(p=>!p.text.trim()&&!p.image))error('文件没有可读取内容。');
  const body={id:crypto.randomUUID(),name:file.name,bytes:file.size,kind,parts};if(new TextEncoder().encode(JSON.stringify(body)).length>limits.payloadBytes)error('文件识别内容过多，请拆分上传。');return body;
}
