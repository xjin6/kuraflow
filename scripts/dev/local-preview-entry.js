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
    button.textContent = '一键进入演示';
    form.addEventListener('submit', async event => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (button.disabled) return;
      button.disabled = true; button.textContent = '正在进入…';
      const error = form.querySelector('.cloud-login-error');
      error.textContent = '';
      try {
        const response = await fetch('/__local-preview/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({portal})});
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '无法进入演示，请重试。');
        location.replace(portal === 'platform' ? '/?login=platform' : portal === 'store' ? '/?view=client' : '/?page=overview');
      } catch (failure) {
        error.textContent = failure.message || '连接失败，请重试。';
        button.disabled = false; button.textContent = '一键进入演示';
      }
    }, true);
  }
  new MutationObserver(enhanceLogin).observe(document, {childList:true, subtree:true});
  enhanceLogin();
})();
