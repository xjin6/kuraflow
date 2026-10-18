import {chromium} from '/Users/xinjin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
const browser=await chromium.launch({headless:true,executablePath:'/Users/xinjin/Library/Caches/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell'});
const page=await browser.newPage({viewport:{width:1440,height:1000}});
try{for(const key of ['overview','orders','catalogue','stores','costs','documents']){
 await page.goto('http://127.0.0.1:4173/?page='+key);await page.locator('.page-content').waitFor();
 const result=await page.evaluate(()=>{
  const rgb=s=>{const m=s.match(/[\d.]+/g);return m?.slice(0,3).map(Number);};
  const lum=xs=>xs.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const seen=new Set(),out=[];
  for(const el of document.querySelectorAll('body *')){
   if(![...el.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())||!el.getClientRects().length)continue;
   const s=getComputedStyle(el);if(s.opacity==='0'||el.closest('button:disabled'))continue;
   let bg=[255,255,255],grad=false;
   for(let p=el;p;p=p.parentElement){const st=getComputedStyle(p);if(st.backgroundImage!=='none'){grad=true;break;}if(!['rgba(0, 0, 0, 0)','transparent'].includes(st.backgroundColor)){bg=rgb(st.backgroundColor);break;}}
   if(grad)continue;const fg=rgb(s.color);if(!fg||!bg)continue;
   const a=lum(fg),b=lum(bg),ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
   const threshold=parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18&&parseFloat(s.fontWeight)>=700)?3:4.5;
   const signature=el.tagName+'.'+el.className+s.color;
   if(ratio<threshold&&!seen.has(signature)){seen.add(signature);out.push({tag:el.tagName,cls:el.className,color:s.color,bg,ratio:+ratio.toFixed(2),font:s.fontSize});}
  }return out;
 });console.log(JSON.stringify({page:key,lowContrast:result}));
}}finally{await browser.close();}
