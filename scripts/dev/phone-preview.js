(() => {
  const input=new URLSearchParams(location.search),query=new URLSearchParams();
  for(const key of ['page','flow','login','view','order','store','tab','filter','demo','date','loginPreview'])if(input.has(key))query.set(key,input.get(key));
  if(!query.has('page')&&!query.has('login')&&!query.has('view'))query.set('page','overview');
  query.set('localPhone','1');
  document.querySelector('iframe').src='/?'+query.toString();
  const area=document.querySelector('main'),frame=document.querySelector('.frame-size'),device=document.querySelector('.device');
  function fit(){const scale=Math.min(1,(area.clientWidth-24)/420,(area.clientHeight-16)/912);frame.style.width=420*scale+'px';frame.style.height=912*scale+'px';device.style.transform='scale('+scale+')';}
  new ResizeObserver(fit).observe(area);fit();
})();
