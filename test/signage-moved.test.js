const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const NEW = 'https://tareq20255.github.io/CONNSCREEN/';

test('رقم الإصدار واحد في index.html و sw.js و CHANGELOG.md', () => {
  const app = /let er="([\d.]+)"/.exec(read('index.html'))[1];
  assert.equal(/const C='wa2p-v([\d.]+)'/.exec(read('sw.js'))[1], app, 'اسم الكاش في sw.js');
  assert.equal(/^## ([\d.]+) /m.exec(read('CHANGELOG.md'))[1], app, 'أول بند في CHANGELOG.md');
});

test('player.html القديم يحوّل لـ CONNSCREEN بنفس الاستعلام ورقمه يختلف عن آخر نسخة كاملة (1.19.0)', () => {
  const html = read('player.html');
  assert.ok(html.includes(`var target = '${NEW}player.html' + location.search + location.hash;`));
  assert.ok(html.includes('location.replace(target)'));
  const v = /var PLAYER_VERSION = '([^']+)'/.exec(html);
  assert.ok(v, 'الشاشات الشغالة تفحص هذا السطر بالضبط');
  assert.notEqual(v[1], '1.19.0');
  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  assert.doesNotMatch(inline, /=>|`|\b(const|let|class|async|await)\s|\bfetch\(/, 'ES5 للمتصفحات القديمة');
});

test('screens.html القديم يحوّل لـ CONNSCREEN', () => {
  assert.ok(read('screens.html').includes(`location.replace('${NEW}')`));
});

test('التطبيق للواتساب فقط: لا تبويب «الشاشات» ولا رابط لها، والشريط السفلي 4 تبويبات', () => {
  const html = read('index.html');
  assert.match(html, /grid grid-cols-4 border-t[^"]*lg:hidden",children:\[\["panel","استيراد",ul\],\["table","الجدول",ui\],\["preview","معاينة",un\],\["order","أوردر",ua\]\]\.map\(/);
  assert.match(html, /\.grid-cols-4\{grid-template-columns:repeat\(4,/, 'تنسيق الأعمدة الأربعة موجود في الـ CSS');
  for (const gone of ['الشاشات', '"screens"', 'screens.html', 'CONNSCREEN', 'repeat(5,minmax']) {
    assert.ok(!html.includes(gone), `index.html ما زال فيه: ${gone}`);
  }
  assert.equal(JSON.parse(read('manifest.webmanifest')).shortcuts, undefined);
});

test('sw.js: لا يحمّل ملفات الشاشات، ويمسح كاشاته القديمة فقط ولا يمس كاش CONNSCREEN', () => {
  const sw = read('sw.js');
  const list = /const A=\[([^\]]+)\]/.exec(sw)[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  for (const file of list) if (file !== './') assert.ok(fs.existsSync(path.join(root, file)), `${file} موجود`);
  assert.ok(!list.some((f) => /signage|screens|player/.test(f)));
  assert.match(sw, /k\.filter\(x=>x\.startsWith\('wa2p-v'\)&&x!==C\)/);
  assert.ok(sw.includes("SHARE='wa2p-share'"), 'كاش المشاركة من واتساب باقٍ');
});
