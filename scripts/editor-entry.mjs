import * as monaco from '../node_modules/monaco-editor/esm/vs/editor/editor.main.js';
globalThis.MonacoEnvironment={getWorkerUrl(_moduleId,label){const worker={json:'json',css:'css',scss:'css',less:'css',html:'html',handlebars:'html',razor:'html',typescript:'ts',javascript:'ts'}[label]||'editor';return `/vendor/editor/${worker}.worker.js`;}};
globalThis.monaco=monaco;
