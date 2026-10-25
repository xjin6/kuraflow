(() => {
  if (location.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(location.hostname)) return;
  window.__KURAFLOW_FLOW_ENABLED__ = true;
  const query = new URLSearchParams(location.search);
  const reviewLogin = query.get('loginPreview') === '1';
  const portal = query.get('login') === 'platform' ? 'platform'
    : query.get('login') === 'store' || query.get('view') === 'client' ? 'store' : 'kitchen';
  const nativeFetch = window.fetch.bind(window);
  // Independent HttpOnly cookies let the three local previews coexist in separate tabs.
  window.fetch = (input, options = {}) => {
    const url = new URL(input instanceof Request ? input.url : input, location.href);
    // Render real login forms for design review without logging out the local session.
    if (reviewLogin && url.origin === location.origin && url.pathname === '/api/accounts/session') {
      return Promise.resolve(new Response(JSON.stringify({authenticated:false}), {headers:{'Content-Type':'application/json'}}));
    }
    if (url.origin === location.origin && (url.pathname.startsWith('/api/') || url.pathname === '/__local-preview/login')) {
      const headers = new Headers(options.headers || (input instanceof Request ? input.headers : undefined));
      headers.set('X-Kuraflow-Preview-Portal', portal);
      return nativeFetch(input, {...options, headers});
    }
    return nativeFetch(input, options);
  };
  const previewText=key=>{const lang=(document.documentElement.lang||'zh').slice(0,2);return ({ja:{enter:'デモに入る',loading:'接続中…',failed:'デモを開けません。もう一度お試しください。'},en:{enter:'Enter demo',loading:'Opening…',failed:'Unable to open the demo. Try again.'},vi:{enter:'Vào bản thử',loading:'Đang mở…',failed:'Không thể mở bản thử. Vui lòng thử lại.'}}[lang]||{enter:'一键进入演示',loading:'正在进入…',failed:'无法进入演示，请重试。'})[key];};
  document.addEventListener('kuraflow:language-change',()=>{const button=document.querySelector('form[data-local-preview] [type=submit]');if(button)button.textContent=previewText(button.disabled?'loading':'enter');});
  function enhanceLogin() {
    const form = document.getElementById('account-login');
    if (!form || form.dataset.localPreview) return;
    if (reviewLogin) {
      const url = new URL(location.href);
      if (url.searchParams.get('loginPreview') !== '1') {
        url.searchParams.set('loginPreview', '1');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
      return;
    }
    form.dataset.localPreview = 'true';
    form.noValidate = true;
    form.querySelectorAll('.field').forEach(field => { field.hidden = true; field.style.display = 'none'; });
    const fields = form.querySelector('.account-login-fields');
    if (fields) { fields.hidden = true; fields.style.display = 'none'; }
    document.querySelectorAll('.account-login-tabs, .accounts-login .form-hint').forEach(el => { el.hidden = true; el.style.display = 'none'; });
    const button = form.querySelector('[type="submit"]');
    button.textContent = previewText('enter');
    form.addEventListener('submit', async event => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (button.disabled) return;
      button.disabled = true; button.textContent = previewText('loading');
      const error = form.querySelector('.cloud-login-error');
      error.textContent = '';
      try {
        const response = await fetch('/__local-preview/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({portal})});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || previewText('failed'));
        location.replace(portal === 'platform' ? '/?login=platform' : portal === 'store' ? '/?view=client' : '/?page=overview');
      } catch (failure) {
        error.textContent = failure.message || previewText('failed');
        button.disabled = false; button.textContent = previewText('enter');
      }
    }, true);
  }
  new MutationObserver(enhanceLogin).observe(document, {childList:true, subtree:true});
  enhanceLogin();
})();
