#!/usr/bin/env node
// يحقن ملفات src/ في index.html بين علامات /*@src name*/ ... /*@end name*/.
//   node build.js          يحدّث index.html
//   node build.js --check  يفشل (exit 1) لو index.html لا يطابق src/
// باقي index.html (React وTailwind وواجهة التطبيق) bundle جاهز لا يُعاد بناؤه هنا.
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, 'index.html');

// لكل وحدة: اسم العلامة، ملف المصدر، وخريطة «الاسم المستخدم داخل الـ bundle» ← «الاسم في المصدر»
const MODULES = [
  {
    name: 'parser',
    file: 'src/parser.js',
    exports: { s$: 'isOrder', sH: 'parseMessage' },
  },
  {
    name: 'share',
    file: 'src/share.js',
    exports: {
      wsIsShare: 'isShareLaunch',
      wsTake: 'takeSharedText',
      wsReadClipboard: 'readClipboardText',
      wsClipMsg: 'clipboardMessage',
    },
  },
  {
    name: 'zip',
    file: 'src/zip.js',
    exports: { wsBlobReader: 'blobReader', wsZipText: 'extractChatText', wsZipMsg: 'zipMessage' },
  },
  {
    name: 'printqueue',
    file: 'src/printqueue.js',
    exports: {
      wsPrintDescribe: 'describePrintError',
      wsUsbSession: 'createUsbSession',
      wsBleSession: 'createBleSession',
      wsSessionSender: 'sessionSender',
      wsRunQueue: 'runQueue',
    },
  },
  {
    name: 'logo',
    file: 'src/logo.js',
    exports: { wsLogoProcess: 'processLogoFile', wsLogoMsg: 'logoMessage' },
  },
  {
    name: 'selection',
    file: 'src/selection.js',
    exports: {
      wsOrderKey: 'orderKey',
      wsSelected: 'selectedOrders',
      wsExcludeAll: 'excludeAll',
      wsExcludePrinted: 'excludePrinted',
      wsPrune: 'pruneExcluded',
      wsToggle: 'toggleOrder',
    },
  },
  {
    name: 'storage',
    file: 'src/storage.js',
    exports: {
      hxLoad: 'loadHistory',
      hxSave: 'saveHistory',
      hxAdd: 'addToHistory',
      hxPrinted: 'printedRefs',
      hxSplit: 'splitPrinted',
      hxTD: 'TEMPLATE_DEFAULTS',
      hxTplClean: 'cleanTemplate',
      hxTplLoad: 'loadTemplate',
      hxTplSave: 'saveTemplate',
    },
  },
];

function render(mod) {
  let src = fs.readFileSync(path.join(__dirname, mod.file), 'utf8').trim();
  src = src.replace(/^'use strict';\s*/, '');
  const exportsRe = /^module\.exports = (\{[\s\S]*?\});\s*$/m;
  if (!exportsRe.test(src)) throw new Error(`${mod.file}: لا يوجد module.exports في آخر الملف`);
  src = src.replace(exportsRe, 'return $1;');
  if (/\bmodule\b|\brequire\(/.test(src)) throw new Error(`${mod.file}: ممنوع استخدام module/require داخل المصدر`);
  const pairs = Object.entries(mod.exports).map(([bundleName, srcName]) => `${srcName}:${bundleName}`);
  // سطر واحد بلا فواصل أسطر زائدة داخل سطر الـ bundle الطويل ليس شرطًا، لكن نحافظ على المصدر مقروءًا
  return `/*@src ${mod.name}*/const {${pairs.join(',')}}=(()=>{\n${src}\n})();/*@end ${mod.name}*/`;
}

function build(html) {
  for (const mod of MODULES) {
    const re = new RegExp(`/\\*@src ${mod.name}\\*/[\\s\\S]*?/\\*@end ${mod.name}\\*/`);
    if (!re.test(html)) throw new Error(`علامة ${mod.name} غير موجودة في index.html`);
    const code = render(mod);
    html = html.replace(re, () => code);
  }
  return html;
}

const current = fs.readFileSync(HTML, 'utf8');
const next = build(current);
if (process.argv.includes('--check')) {
  if (next !== current) {
    console.error('index.html لا يطابق src/ — شغّل: node build.js');
    process.exit(1);
  }
  console.log('index.html مطابق لـ src/');
} else if (next !== current) {
  fs.writeFileSync(HTML, next);
  console.log('تم تحديث index.html');
} else {
  console.log('لا تغيير');
}
