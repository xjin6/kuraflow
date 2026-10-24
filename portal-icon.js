// Public derivatives of the approved 04-Square-Icon assets; no account data.
const portalColors = { platform: 'purple', kitchen: 'blue', admin: 'blue', store: 'orange', client: 'orange' };

export function portalBrandColor(portal) {
  return portalColors[portal] || 'blue';
}

export function setPortalIcon(portal) {
  const color = portalBrandColor(portal);
  document.documentElement.dataset.portalTheme = color;
  const base = `/public/brand/kuraflow-${color}`;
  for (const [id, rel, type, sizes, href] of [
    ['portal-icon-png', 'icon', 'image/png', '32x32', `${base}-32.png`],
    ['portal-icon-svg', 'icon', 'image/svg+xml', 'any', `${base}.svg`],
    ['portal-touch-icon', 'apple-touch-icon', 'image/png', '180x180', `${base}-apple-touch.png`],
  ]) {
    let link = document.getElementById(id);
    if (!link) {
      link = document.createElement('link');
      link.id = id;
      document.head.append(link);
    }
    link.rel = rel;
    link.type = type;
    link.setAttribute('sizes', sizes);
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
  }
}

const params = new URLSearchParams(location.search);
setPortalIcon(params.get('login') || params.get('portal') || (params.get('view') === 'client' ? 'store' : 'kitchen'));
