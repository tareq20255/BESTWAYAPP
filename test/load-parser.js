// يستخرج دوال الـ parser من index.html (الكود مدمج ومصغّر) ليختبرها node:test
// بدون تغيير الملف المنشور. لو تغيّرت أسماء الدوال بعد إعادة البناء حدّث العلامات هنا.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('let sT="\\\\d[\\\\d,]*');
const end = html.indexOf('let sW=e=>e.qty');
if (start < 0 || end < start) throw new Error('تعذر العثور على كود الـ parser في index.html');

const src = html.slice(start, end);
module.exports = new Function(`${src}\nreturn {isOrder:s$, parseOrder:sB, parseMessage:sH, isHeader:sC};`)();
