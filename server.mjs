import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 4173);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
const allowed = new Set(['notifications-ui.js','notifications.css','notification-domain.js','local-notifications.js','accounts-ui.js', 'avatar-editor.js', 'accounts.css', 'flow-ui.js', 'flow-ui.css','flow-mark.svg', 'index.html', 'app.js', 'data.js', 'cloud-client.js', 'business-data.js', 'business-ui.js', 'store-ui.js', 'ui-controls.js', 'ui-motion.js', 'japan-addresses.js', 'styles.css', 'catalogue-units.css', 'store-ui.css', 'readability.css', 'ui-system.css', 'ui-controls.css', 'order-ui.css', 'visual-refresh.css', 'favicon.svg', 'overview-data.js', 'overview-ui.js', 'tasks-ui.js', 'overview.css', 'settlement-data.js', 'settlement-ui.js', 'settlement.css', 'order-pdf.js', 'public/vendor/pdf-engine.js', 'public/vendor/pdf-engine.LICENSE.txt', 'public/vendor/fontkit-LICENSE.txt', 'public/fonts/KuraflowDocumentSans.ttf', 'public/fonts/NotoSansSC-LICENSE.txt', 'public/fonts/Geist-Variable.woff2', 'public/fonts/GeistMono-Variable.woff2', 'public/fonts/LICENSE.txt',
  'materials/永辉株式会社10.5纳品书.pdf', 'materials/附件一：产品清单.pdf', 'materials/每度商事产品成本价格表.xlsx',
  'materials/每度商事_客户产品报价单_.pdf', 'materials/杨国福京都河原店_2026年9月请求书_含运费.pdf', 'materials/订货单案例.jpg']);
const server = http.createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if(['/__local-preview/phone','/__local-preview/phone.js'].includes(path)) {
      const script=path.endsWith('.js'),file=script?'scripts/phone-preview.js':'scripts/phone-preview.html';
      response.writeHead(200,{'Content-Type':script?'application/javascript; charset=utf-8':'text/html; charset=utf-8','Cache-Control':'no-store'});
      response.end(request.method==='HEAD'?undefined:await readFile(fileURLToPath(new URL(file,import.meta.url))));return;
    }
    const name = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
    const photo = /^public\/product-images\/(\d+)\.jpg$/.exec(name);
    if (!allowed.has(name) && !(photo && Number(photo[1]) >= 1 && Number(photo[1]) <= 72)) { response.writeHead(404); response.end('Not found'); return; }
    const body = await readFile(fileURLToPath(new URL(name, import.meta.url)));
    const extension = name.slice(name.lastIndexOf('.'));
    const contentType = mime[extension] || 'text/plain';
    response.writeHead(200, { 'Content-Type': contentType + (['.html', '.js', '.css', '.svg'].includes(extension) ? '; charset=utf-8' : ''), 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch { response.writeHead(500); response.end('Unable to load the prototype'); }
});
server.listen(port, '127.0.0.1', () => console.log(`倉流 KURAFLOW is ready at http://127.0.0.1:${port}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
