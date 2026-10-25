import { PDFDocument, rgb, fontkit, TTFReader, TTFWriter } from '../../../public/vendor/pdf-engine.js';
import { tokyoDate, roundAmount } from '../../shared/settlement-data.js';

const fontLoads=new Map();
async function loadFont(name) {
  if(!fontLoads.has(name))fontLoads.set(name,fetch('/public/fonts/'+name).then(response=>{
    if(!response.ok)throw new Error('PDF 字体加载失败，请稍后重试。');return response.arrayBuffer();
  }).catch(error=>{fontLoads.delete(name);throw error;}));
  return fontLoads.get(name);
}
const clean=value=>String(value??'').replace(/[\r\n\t]+/g,' ').replace(/[\u0000-\u001f\u007f]/g,'');
const known=value=>value!==null&&value!==undefined&&Number.isFinite(Number(value));
const number=(value,grouped=false)=>known(value)?Number(value).toLocaleString('en-US',{useGrouping:grouped,maximumFractionDigits:2}):'未確定';
const money=value=>known(value)?'¥'+number(value,true)+' -':'未確定';
const PAGE=[841.68,595.44];
const GRID=[50.52,402.36,457.80,558.60,601.32,657.36];
const GRID_TOP=256.92,HEADER=14.04,BODY_BOTTOM=466.08;
const INK=rgb(0,0,0),TITLE=rgb(.573,.804,.863),HEADER_FILL=rgb(.718,.871,.910);
const sealPath=value=>typeof value==='string'&&/^\/api\/images\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

async function loadSeal(issuer,provided) {
  if(provided)return new Uint8Array(provided);
  if(!issuer.sealUrl)return null;
  if(!sealPath(issuer.sealUrl))throw new Error('公章地址无效，请检查开票资料。');
  const response=await fetch(issuer.sealUrl,{credentials:'same-origin',cache:'no-store'});
  if(!response.ok)throw new Error('公章加载失败，请重试；尚未导出 PDF。');
  const bytes=new Uint8Array(await response.arrayBuffer());
  if(bytes.length>204800)throw new Error('公章文件过大，请重新配置。');
  return bytes;
}

/** Landscape delivery note. Layout coordinates follow the approved October 17 reference. */
export async function createOrderPDF(record,{fontBytes,serifFontBytes,sealBytes,issuedDate=tokyoDate()}={}) {
  const [sansData,serifData,sealData]=await Promise.all([
    fontBytes||loadFont('KuraflowDocumentSans.ttf'),serifFontBytes||loadFont('KuraflowDocumentSerif.ttf'),loadSeal(record.issuer,sealBytes),
  ]);
  const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
  const metrics=await PDFDocument.create();metrics.registerFontkit(fontkit);
  const sans=await metrics.embedFont(new Uint8Array(sansData),{subset:false});
  const serif=await metrics.embedFont(new Uint8Array(serifData),{subset:false});
  const textRuns=[];
  let seal;
  if(sealData) {
    try {seal=sealData[0]===137?await doc.embedPng(sealData):await doc.embedJpg(sealData);}
    catch {throw new Error('公章文件无法读取，请使用 PNG 或 JPEG 图片。');}
  }
  doc.setTitle(`${clean(record.store.name)} - ${clean(record.id)} - 納品書`);
  doc.setAuthor(clean(record.issuer.name));doc.setCreator('KuraFlow');
  doc.setSubject(`注文番号 ${clean(record.id)} / 配送日 ${clean(record.order.deliveryDate)}`);
  let page;
  const widthOf=(value,size=9,font=serif)=>font.widthOfTextAtSize(clean(value),size);
  function text(value,x,baseline,size=9,align='left',font=serif,bold=false) {
    const valueText=clean(value);if(!valueText)return;
    const start=align==='center'?x-widthOf(valueText,size,font)/2:align==='right'?x-widthOf(valueText,size,font):x;
    const options={x:start,y:PAGE[1]-baseline,size,color:INK};
    textRuns.push({page,value:valueText,kind:font===sans?'sans':'serif',options});
    if(bold)textRuns.push({page,value:valueText,kind:font===sans?'sans':'serif',options:{...options,x:start+.18}});
  }
  function wrap(value,width,size=9,font=serif) {
    const lines=[];let current='';
    for(const char of clean(value)){if(current&&widthOf(current+char,size,font)>width){lines.push(current);current='';}current+=char;}
    if(current)lines.push(current);return lines.length?lines:[''];
  }
  function rule(x1,top1,x2,top2,thickness=.60){page.drawLine({start:{x:x1,y:PAGE[1]-top1},end:{x:x2,y:PAGE[1]-top2},thickness,color:INK});}
  function rectangle(x,top,width,height,color){page.drawRectangle({x,y:PAGE[1]-top-height,width,height,color});}
  function centeredLines(value,center,baseline,width,size=9,leading=11.3,font=serif) {
    const lines=wrap(value,width,size,font);lines.forEach((row,i)=>text(row,center,baseline+i*leading,size,'center',font));return lines.length*leading;
  }
  const totals=[];
  const allInclusive=record.lines.length>0&&record.lines.every(row=>row.taxBasis==='inclusive'&&known(row.tax));
  const hasInclusive=record.lines.some(row=>row.taxBasis==='inclusive'&&known(row.tax));
  if(!known(record.gross)) {
    totals.push([record.unpriced?'確認済み小計':'小計',record.amount],['消費税',null],['税込合計',null]);
  } else {
    totals.push([allInclusive?'小計（税込）':'小計',allInclusive?record.gross:record.net]);
    for(const group of record.taxGroups)totals.push([`${allInclusive?'内消費税':'消費税'}（${number(group.rate*100)}%）`,group.tax]);
    if(!record.taxGroups.length)totals.push(['消費税',record.tax]);
    totals.push(['税込合計',record.gross]);
  }
  const hasShipping=known(record.shipping)&&Number(record.shipping)!==0;
  if(hasShipping) {
    totals.push(['運賃',record.shipping],['運賃消費税',record.shippingTax]);
    totals.push(['総合計',known(record.gross)&&known(record.shippingTax)?roundAmount(record.gross+record.shipping+record.shippingTax):null]);
  }
  const notes=[];
  if(record.unpriced)notes.push('単価未確定の明細は小計に含めていません。');
  if(record.taxUnknown)notes.push('税区分未確認のため、消費税と税込合計は未確定です。');
  if(hasInclusive&&!allInclusive)notes.push('※ 税込表示の明細は、消費税を控除して小計を計算しています。');
  if(!known(record.shipping))notes.push('運賃未確認（上記金額には含みません）。');
  if(record.order.isDemo)notes.push('デモ注文 / 演示订单');
  if(record.order.note&&!record.order.isDemo)notes.push('備考：'+clean(record.order.note));
  const headerExtras=[];
  const clipHeader=(value,maxWidth,size,maxLines,label,font=serif)=>{
    const rows=wrap(value,maxWidth,size,font);
    if(rows.length<=maxLines)return rows;
    headerExtras.push(label+clean(value));
    return [...rows.slice(0,maxLines-1),rows[maxLines-1].slice(0,-1)+'…'];
  };
  const recipientRows=clipHeader(clean(record.store.name)+'御中',335,18,3,'納品先：',sans);
  const issuerWidth=seal?126:220;
  const companyRows=clipHeader(record.issuer.name,issuerWidth,9,1,'発行者：');
  const addressRows=clipHeader(record.issuer.address,issuerWidth,9,2,'発行者住所：');
  const phoneRows=clipHeader(record.issuer.phone?'電話：'+record.issuer.phone:'',issuerWidth,9,1,'発行者電話：');
  const representativeRows=clipHeader(record.issuer.representative?'代表取締役：'+record.issuer.representative:'',220,9,2,'');
  const noteLines=[...notes,...headerExtras].flatMap(note=>wrap(note,GRID[5]-GRID[0],8));
  const nameFor=line=>{
    const name=clean(line.name),spec=clean(line.spec);
    const full=spec&&!name.replaceAll(' ','').includes(spec.replaceAll(' ',''))?name+' '+spec:name;
    return full+(line.taxBasis==='inclusive'&&known(line.tax)?'（税込）':'');
  };
  // Every row is wrapped before pagination; even a single oversized name can
  // continue without repeating its quantity/amount or dropping any text.
  const fragments=[];
  for(const line of record.lines) {
    const cells=[wrap(nameFor(line),GRID[1]-GRID[0]-10),wrap(number(line.qty),GRID[2]-GRID[1]-6),wrap(line.unit,GRID[3]-GRID[2]-6),wrap(number(line.price),GRID[4]-GRID[3]-6),wrap(number(line.total),GRID[5]-GRID[4]-6)];
    const count=Math.max(...cells.map(c=>c.length));
    for(let start=0;start<count;start+=17)fragments.push({cells:cells.map(c=>c.slice(start,start+17)),height:Math.max(14.04,Math.min(17,count-start)*10.6+3.44)});
  }
  if(!fragments.length)fragments.push({cells:[['明細なし'],[],[],[],[]],height:14.04});
  const sheets=[];let rows=[],height=0;
  for(const fragment of fragments) {
    if(rows.length&&height+fragment.height>BODY_BOTTOM-GRID_TOP-HEADER+.01){sheets.push(rows);rows=[];height=0;}
    // The reference's fourth body row is 1.44 pt shorter than the other rows.
    const rowHeight=rows.length===3&&fragment.height===14.04?12.60:fragment.height;
    rows.push({...fragment,height:rowHeight});height+=rowHeight;
  }
  sheets.push(rows);
  const grandTotal=hasShipping?totals.at(-1)[1]:record.gross;
  function header() {
    page=doc.addPage(PAGE);
    text('発行日：'+clean(issuedDate).replaceAll('-','/'),540.84,76.86,13.12,'center');
    recipientRows.forEach((row,i)=>text(row,217.44,102.5+i*21,18,'center',sans));
    rectangle(423.96,90.12,233.76,28.8,TITLE);rule(423.36,118.56,657.72,118.56,.72);
    text('納品書',540.72,116.32,13.12,'center',sans,true);
    companyRows.forEach(row=>text(row,540.6,132,9,'center'));
    addressRows.forEach((row,i)=>text(row,540.6,147.3+i*11.3,9,'center'));
    phoneRows.forEach(row=>text(row,540.6,147.3+addressRows.length*11.3,9,'center'));
    representativeRows.forEach((row,i)=>text(row,540.6,193.22+i*11.3,9,'center'));
    if(seal)page.drawImage(seal,{x:604.7,y:PAGE[1]-166.5,width:52,height:47.2});
    text(record.order.stage==='delivered'?'下記の通り納品いたしました。':'下記の通り納品予定です。',237.6,182.81,9,'center');
    text('金額（税込）',102,229.12,18);
    text(money(grandTotal),323.84,229.12,18,'center');rule(50.16,245.64,402.72,245.64,.72);
    rectangle(GRID[0],GRID_TOP,GRID[5]-GRID[0],HEADER,HEADER_FILL);
    ['項目','数量','単位/ｋｇ/ｐ/cs','単価','金額'].forEach((label,index)=>text(label,(GRID[index]+GRID[index+1])/2,267.76,9,'center'));
    rule(GRID[0],GRID_TOP,GRID[5],GRID_TOP);rule(GRID[0],GRID_TOP+HEADER,GRID[5],GRID_TOP+HEADER);
  }
  function drawRow(row,top) {
    row.cells.forEach((cell,index)=>cell.forEach((line,lineIndex)=>text(line,(GRID[index]+GRID[index+1])/2,top+row.height/2+3-(cell.length-1)*5.3+lineIndex*10.6,9,'center')));
    rule(GRID[0],top+row.height,GRID[5],top+row.height);
  }
  for(let sheet=0;sheet<sheets.length;sheet++) {
    header();let top=GRID_TOP+HEADER,index=0;
    for(const row of sheets[sheet]){drawRow(row,top);top+=row.height;index++;}
    while(top<BODY_BOTTOM-.01){const rowHeight=Math.min(BODY_BOTTOM-top,index===3?12.6:14.04);drawRow({cells:[],height:rowHeight},top);top+=rowHeight;index++;}
    GRID.forEach(x=>rule(x,GRID_TOP,x,BODY_BOTTOM));
    if(sheet===sheets.length-1) {
      for(const [totalIndex,[label,value]] of totals.entries()) {
        if(top+HEADER>PAGE[1]-34){page=doc.addPage(PAGE);top=80;text(clean(record.store.name)+'御中',GRID[0],45,12,'left',sans);text('納品書 / 集計',GRID[5],45,12,'right',sans);rule(GRID[0],top,GRID[5],top);}
        text(label,(totalIndex===0?GRID[3]:GRID[4])-2,top+10.84,9,'right');text(number(value,true),(GRID[4]+GRID[5])/2,top+10.84,9,'center');
        if(totalIndex===0)[GRID[3],(GRID[3]+GRID[4])/2].forEach(x=>rule(x,top,x,top+HEADER));
        rule(GRID[0],top+HEADER,GRID[5],top+HEADER);
        [GRID[0],GRID[4],GRID[5]].forEach(x=>rule(x,top,x,top+HEADER));top+=HEADER;
      }
      // Additional taxes/freight and lengthy remarks can continue on their own
      // page without colliding with totals. Ordinary notes keep the reference grid.
      for(const line of noteLines) {
        if(top+18>PAGE[1]-30){page=doc.addPage(PAGE);top=70;text(clean(record.store.name)+'御中',GRID[0],45,12,'left',sans);text('納品書 / 備考',GRID[5],45,12,'right',sans);}
        text(line,GRID[0],top+16,8);top+=12;
      }
    } else {
      text('次頁へ続く',GRID[5],BODY_BOTTOM+20,9,'right');
    }
  }
  const pages=doc.getPages();
  if(pages.length>1)pages.forEach((entry,index)=>{page=entry;text(`${index+1} / ${pages.length}`,GRID[5],PAGE[1]-22,8,'right');});
  // Build valid TrueType subsets from the actual final text. Fontkit's direct
  // subset embedding drops CJK glyphs in several PDF viewers; whole fonts are
  // used only for measurement and never included in the downloadable file.
  const fonts={};
  for(const [kind,source] of [['sans',sansData],['serif',serifData]]) {
    const unicode=[...new Set(textRuns.filter(run=>run.kind===kind).flatMap(run=>Array.from(run.value,char=>char.codePointAt(0))))];
    const bytes=new Uint8Array(source),buffer=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    const reader=new TTFReader({subset:unicode,hinting:false,compound2simple:true});
    const writer=new TTFWriter({hinting:false,kerning:false});
    const subset=writer.write(reader.read(buffer));reader.dispose();writer.dispose();
    fonts[kind]=await doc.embedFont(new Uint8Array(subset),{subset:false});
  }
  for(const run of textRuns)run.page.drawText(run.value,{...run.options,font:fonts[run.kind]});
  return doc.save();
}
