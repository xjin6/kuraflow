import { PDFDocument, rgb, fontkit } from './public/vendor/pdf-engine.js';
import { tokyoDate, roundAmount } from './settlement-data.js';

let fontPromise;
async function loadFont() {
  if (!fontPromise) fontPromise=fetch('/public/fonts/KuraflowDocumentSans.ttf').then(response=>{
    if(!response.ok)throw new Error('PDF 字体加载失败，请稍后重试。');return response.arrayBuffer();
  }).catch(error=>{fontPromise=null;throw error;});
  return fontPromise;
}
const numeric = value => Number(value).toLocaleString('en-US',{maximumFractionDigits:2});
const currency = value => value === null ? '未確定' : '¥ '+numeric(value);
const clean = value => String(value ?? '').replace(/[\r\n\t]+/g,' ').replace(/[\u0000-\u001f\u007f]/g,'');
const stageText={pending:'未出荷',packing:'出荷準備中',ready:'出荷待ち',delivering:'配送中',delivered:'納品済み'};

export async function createOrderPDF(record, { fontBytes, issuedDate = tokyoDate() } = {}) {
  const doc=await PDFDocument.create();doc.registerFontkit(fontkit);
  const font=await doc.embedFont(new Uint8Array(fontBytes || await loadFont()),{subset:false});
  doc.setTitle(`${record.store.name} - ${record.id} - 納品書`);doc.setAuthor(record.issuer.name || '');doc.setCreator('Kuraflow');
  const pageWidth=595.28,pageHeight=841.89,left=40,right=555.28,width=right-left;
  const ink=rgb(.12,.17,.20),muted=rgb(.38,.44,.48),border=rgb(.42,.48,.51),fill=rgb(.89,.94,.96);
  const columns=[left,left+250,left+300,left+341,left+420,right];
  let page, y, pageIndex=0;
  const widthOf=(text,size)=>font.widthOfTextAtSize(clean(text),size);
  function text(value,x,y,size=9,color=ink,align='left') {
    const safe=clean(value);if(!safe)return;
    page.drawText(safe,{x:align==='right'?x-widthOf(safe,size):align==='center'?x-widthOf(safe,size)/2:x,y,size,font,color});
  }
  function wrap(value,maxWidth,size=9) {
    const result=[];let row='';
    for(const char of clean(value)) {if(row && widthOf(row+char,size)>maxWidth){result.push(row);row='';}row+=char;}
    if(row)result.push(row);return result.length?result:[''];
  }
  function lines(value,x,top,maxWidth,size=9,leading=13) {
    const rows=wrap(value,maxWidth,size);rows.forEach((row,i)=>text(row,x,top-i*leading,size));return top-rows.length*leading;
  }
  function rule(x1,y1,x2,y2,thickness=.45,color=border) {page.drawLine({start:{x:x1,y:y1},end:{x:x2,y:y2},thickness,color});}
  function header() {
    page=doc.addPage([pageWidth,pageHeight]);pageIndex++;
    if(pageIndex===1) {
      text('発行日：'+issuedDate.replaceAll('-','/'),right,797,9,muted,'right');
      const titleX=350;page.drawRectangle({x:titleX,y:755,width:right-titleX,height:26,color:fill});
      text('納 品 書',(titleX+right)/2,763,15,ink,'center');
      let senderY=742;
      senderY=lines(record.issuer.name,titleX,senderY,right-titleX,10,14);
      if(record.issuer.address)senderY=lines(record.issuer.address,titleX,senderY-2,right-titleX,8.5,12);
      if(record.issuer.phone){text('電話：'+record.issuer.phone,titleX,senderY-2,8.5);senderY-=14;}
      if(record.issuer.contact)senderY=lines('担当：'+record.issuer.contact,titleX,senderY-2,right-titleX,8.5,12);
      let recipientY=lines(record.store.name+' 御中',left,765,284,14,20);
      rule(left,recipientY+4,left+280,recipientY+4,.8);
      if(record.store.address)recipientY=lines(record.store.address,left,recipientY-14,284,9,13);
      if(record.store.contact)recipientY=lines('ご担当：'+record.store.contact,left,recipientY-4,284,9,13);
      if(record.store.phone){text('電話：'+record.store.phone,left,recipientY-5,9);recipientY-=18;}
      const metaY=Math.min(650,recipientY-24,senderY-20);
      text('注文番号：'+record.id,left,metaY,8.5);
      text('配送日：'+clean(record.order.deliveryDate),right,metaY,8.5,ink,'right');
      text('状態：'+(stageText[record.order.stage]||record.order.stage)+(record.order.isDemo?' / デモ':''),left,metaY-17,8.5,muted);
      const totalLabel=record.gross!==null?'商品金額（税込）':record.unpriced?'確認済み商品金額':'商品金額（税区分未確認）';
      text(totalLabel,left,metaY-46,10);
      text(currency(record.gross ?? record.amount),right,metaY-48,19,ink,'right');
      rule(left,metaY-59,right,metaY-59,.7);y=metaY-72;
    } else {
      text(record.store.name+' 御中',left,794,11);
      text('納品書 / 続き',right,794,11,ink,'right');
      text('注文番号：'+record.id,left,773,8.5,muted);
      text('配送日：'+clean(record.order.deliveryDate),right,773,8.5,muted,'right');y=751;
    }
    page.drawRectangle({x:left,y:y-23,width,height:23,color:fill});
    ['項目 / 規格','数量','単位','単価','金額'].forEach((label,i)=>text(label,(columns[i]+columns[i+1])/2,y-15,9,ink,'center'));
    rule(left,y,right,y,.6);rule(left,y-23,right,y-23,.6);
    columns.forEach(x=>rule(x,y,x,y-23));y-=23;
  }
  function row(cells,height) {
    cells[0].forEach((value,i)=>text(value,left+7,y-15-i*12,9));
    text(cells[1],columns[2]-7,y-15,9,ink,'right');text(cells[2],(columns[2]+columns[3])/2,y-15,9,ink,'center');
    text(cells[3],columns[4]-7,y-15,9,ink,'right');text(cells[4],right-7,y-15,9,ink,'right');
    columns.forEach(x=>rule(x,y,x,y-height));rule(left,y-height,right,y-height);y-=height;
  }
  header();
  for(const line of record.lines) {
    const name=wrap([line.name,line.spec].filter(Boolean).join('  '),236,9);
    const height=Math.max(25,name.length*12+12);
    if(y-height<182)header();
    row([name,numeric(line.qty),line.unit,line.price===null?'未確定':numeric(line.price),line.total===null?'未確定':numeric(line.total)],height);
  }
  if(!record.lines.length)row([['明細なし'],'','','',''],25);
  function continuation(label) {
    page=doc.addPage([pageWidth,pageHeight]);pageIndex++;
    text(record.store.name+' 御中',left,794,11);text('納品書 / '+label,right,794,11,ink,'right');
    text('注文番号：'+record.id,left,773,8.5,muted);rule(left,760,right,760,.6);return 744;
  }
  const totals=record.gross===null
    ? [[record.unpriced?'確認済み小計':'商品小計',currency(record.amount)],['消費税','未確定'],['税込商品合計','未確定']]
    : [['税抜小計',currency(record.net)],...record.taxGroups.map(group=>[`消費税 (${numeric(group.rate*100)}%)`,currency(group.tax)]),['税込商品合計',currency(record.gross)]];
  totals.push(['運賃',record.shipping===null?'別途確認':currency(record.shipping)]);
  if(record.gross!==null&&record.shipping!==null&&record.shippingTax!==null)totals.push(['総合計',currency(roundAmount(record.gross+record.shipping+record.shippingTax))]);
  const totalsHeight=totals.length*21;
  if(y-Math.min(totalsHeight,680)<60)y=continuation('集計');
  let totalY=y-17;
  totals.forEach(([label,value],index)=>{
    const nextPage=totalY-6<52;
    if(nextPage){y=continuation('集計');totalY=y-17;}
    const top=totalY+15,bottom=totalY-6;
    if(index===totals.length-1)page.drawRectangle({x:columns[3],y:bottom,width:right-columns[3],height:21,color:fill});
    text(label,columns[4]-9,totalY,8.5,muted,'right');text(value,right-7,totalY,9.5,ink,'right');
    rule(columns[3],bottom,right,bottom);if(index===0||nextPage)rule(columns[3],top,right,top);
    rule(columns[3],top,columns[3],bottom);rule(right,top,right,bottom);totalY-=21;
  });
  let noteY=y-16;
  const notes=[];
  if(record.unpriced)notes.push('単価未確定の明細は合計に含めていません。');
  if(record.taxUnknown)notes.push('税区分が未確認のため、税込合計は未確定です。');
  if(record.order.receivedBy)notes.push('受領者：'+record.order.receivedBy);
  if(record.order.note && !record.order.isDemo)notes.push('備考：'+record.order.note);
  for(const note of notes){for(const row of wrap(note,274,8)){if(noteY<60)noteY=continuation('備考');text(row,left,noteY,8);noteY-=12;}noteY-=5;}
  const pages=doc.getPages();pages.forEach((p,index)=>{page=p;text(record.id,left,28,8,muted);text(`${index+1} / ${pages.length}`,right,28,8,muted,'right');});
  return doc.save();
}
