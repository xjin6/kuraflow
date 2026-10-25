import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
const mode=process.argv[2];
if(mode==='js'){
 const js=fs.readFileSync(0,'utf8');
 process.stdout.write(execFileSync('osascript',['-e','tell application "Safari" to do JavaScript '+JSON.stringify(js)+' in front document'],{encoding:'utf8'}));
}else if(mode==='open'){
 const url=process.argv[3];if(!/^https?:\/\//.test(url))throw new Error('Expected http(s) URL');
 execFileSync('osascript',['-e','tell application "Safari" to set URL of front document to '+JSON.stringify(url)],{encoding:'utf8'});
}else throw new Error('Use js or open');
