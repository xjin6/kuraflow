import {readFile, writeFile} from 'node:fs/promises';

const source = new URL('../cloud-seed.js', import.meta.url);
const target = new URL('../business-data.js', import.meta.url);

try {
  await writeFile(target, await readFile(source), {flag: 'wx', mode: 0o600});
  console.log('Created empty local business data; no business records imported.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Existing local business data preserved.');
}
