import {build} from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
await fs.mkdir(path.join(root,'public/vendor'),{recursive:true});
await build({stdin:{contents:"export {PDFDocument,rgb,StandardFonts} from 'pdf-lib'; export {default as fontkit} from '@pdf-lib/fontkit'; import reader from 'fonteditor-core/lib/ttf/ttfreader'; import writer from 'fonteditor-core/lib/ttf/ttfwriter'; export const TTFReader=reader.default||reader,TTFWriter=writer.default||writer;",resolveDir:root},outfile:path.join(root,'public/vendor/pdf-engine.js'),bundle:true,platform:'browser',format:'esm',target:['safari17','chrome120'],minify:true,legalComments:'eof'});
const licenses=[await fs.readFile(path.join(root,'node_modules/pdf-lib/LICENSE.md'),'utf8'),await fs.readFile(path.join(root,'public/vendor/fontkit-LICENSE.txt'),'utf8'),await fs.readFile(path.join(root,'node_modules/fonteditor-core/LICENSE'),'utf8')];
await fs.writeFile(path.join(root,'public/vendor/pdf-engine.LICENSE.txt'),licenses.join('\n\n'));
