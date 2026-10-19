import {build} from 'esbuild';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const patchedPurifier=path.join(path.dirname(require.resolve('dompurify')),'purify.es.mjs');
// Monaco includes a vendored sanitizer. Bundle our patched version instead and
// serve only these compiled artifacts, never the package's prebuilt assets.
const patchedSanitizer={name:'patched-sanitizer',setup(b){b.onResolve({filter:/\/dompurify\/dompurify\.js$/},()=>({path:patchedPurifier}));}};
const common={bundle:true,minify:true,target:'es2022',format:'iife',legalComments:'eof',plugins:[patchedSanitizer],logLevel:'info',loader:{'.ttf':'file'},assetNames:'assets/[name]-[hash]'};
await build({...common,entryPoints:['scripts/editor-entry.mjs'],outfile:'public/vendor/editor/monaco.js'});
for(const [name,file]of Object.entries({editor:'editor/editor.worker.js',json:'language/json/json.worker.js',css:'language/css/css.worker.js',html:'language/html/html.worker.js',ts:'language/typescript/ts.worker.js'})){
 await build({...common,entryPoints:[path.join('node_modules/monaco-editor/esm/vs',file)],outfile:`public/vendor/editor/${name}.worker.js`});
}
