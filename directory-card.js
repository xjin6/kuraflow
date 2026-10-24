// Shared card shell for management and platform store directories.
// All values below are already escaped or rendered by the caller's UI helpers.
export function storeCardAddress(store) {
  const saved=String(store.address||'').trim();
  const structured=[store.prefecture,store.municipality,store.ward,store.addressDetail].filter(Boolean).join('');
  return saved&&!['待填写','待录入','—'].includes(saved)?saved:structured||'配送地址待填写';
}

export function storeDirectoryCard({attributes='',title,subtitle,image,status,tools='',details,actions}) {
  return `<article class="store-card store-identity-card" ${attributes}>
    <div class="store-card-media">${image}</div>
    <header class="store-card-heading"><div class="store-card-identity">
      <div class="store-card-title-line"><h3>${title}</h3>${status}</div>
      <div class="store-card-subline"><span class="store-city">${subtitle}</span>${tools?`<div class="store-card-tools">${tools}</div>`:''}</div>
    </div></header>
    <div class="store-card-info">${details}</div>
    <footer class="store-card-footer">${actions}</footer>
  </article>`;
}
