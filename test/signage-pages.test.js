const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const config = require('../src/signage-config');

test('رقم الإصدار واحد في index.html و sw.js و CHANGELOG.md و player.html', () => {
  const app = /let er="([\d.]+)"/.exec(read('index.html'))[1];
  assert.equal(/const C='wa2p-v([\d.]+)'/.exec(read('sw.js'))[1], app, 'اسم الكاش في sw.js');
  assert.equal(/^## ([\d.]+) /m.exec(read('CHANGELOG.md'))[1], app, 'أول بند في CHANGELOG.md');
  assert.equal(/PLAYER_VERSION = '([\d.]+)'/.exec(read('player.html'))[1], app, 'PLAYER_VERSION في player.html');
});

test('sw.js: كل ملفات الكاش المسبق موجودة (ملف ناقص يُفشل تثبيت الـ Service Worker كله)', () => {
  const list = /const A=\[([^\]]+)\]/.exec(read('sw.js'))[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  for (const file of ['screens.html', 'player.html', 'src/signage-config.js', 'src/signage-core.js', 'src/signage-api.js']) {
    assert.ok(list.includes(file), `${file} في قائمة الكاش`);
  }
  for (const file of list) {
    if (file === './') continue;
    assert.ok(fs.existsSync(path.join(root, file)), `${file} موجود`);
  }
});

test('sw.js: طلبات Supabase لا يعترضها الـ Service Worker', () => {
  assert.match(read('sw.js'), /hostname\.endsWith\('\.supabase\.co'\)\)return;/);
  assert.ok(new URL(config.url).hostname.endsWith('.supabase.co'));
});

test('index.html: تبويب «الشاشات» في الشريط السفلي ورابط سطح المكتب', () => {
  const html = read('index.html');
  assert.match(html, /\["order","أوردر",ua\],\["screens","الشاشات","[^"]+"\]\]\.map\(/);
  assert.ok(html.includes('if("screens"===e)return void(location.href="screens.html");'));
  assert.ok(html.includes('gridTemplateColumns:"repeat(5,minmax(0,1fr))"'));
  assert.ok(html.includes('("a",{href:"screens.html"'));
  const shortcuts = JSON.parse(read('manifest.webmanifest')).shortcuts;
  assert.ok(shortcuts.some((s) => s.url === './screens.html'));
});

test('الصفحتان تحمّلان ملفات موجودة', () => {
  for (const page of ['screens.html', 'player.html']) {
    const scripts = [...read(page).matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.includes('src/signage-config.js'), `${page} يحمّل الإعدادات`);
    for (const src of scripts) assert.ok(fs.existsSync(path.join(root, src)), `${page}: ${src}`);
  }
  assert.deepEqual(
    [...read('screens.html').matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]),
    ['src/signage-config.js', 'src/signage-core.js', 'src/signage-api.js'],
  );
});

test('المشغّل والإعدادات بصياغة ES5 (متصفحات الشاشات قديمة)', () => {
  const inline = /<script>([\s\S]*?)<\/script>/.exec(read('player.html'))[1];
  for (const [name, code] of [['player.html', inline], ['src/signage-config.js', read('src/signage-config.js')]]) {
    assert.doesNotMatch(code, /=>/, `${name}: دالة سهمية`);
    assert.doesNotMatch(code, /`/, `${name}: قالب نصي`);
    assert.doesNotMatch(code, /\b(const|let|class|async|await)\s/, `${name}: صياغة ES6`);
    assert.doesNotMatch(code, /\bfetch\(/, `${name}: fetch غير متاح على WebView قديم`);
  }
  // CSS: خصائص غير مدعومة قبل Chrome 79–88
  const css = /<style>([\s\S]*?)<\/style>/.exec(read('player.html'))[1];
  assert.doesNotMatch(css, /\binset\s*:|\bgap\s*:|clamp\(|aspect-ratio/);
});

test('الإعدادات: مفتاح publishable فقط ولا أسرار في المستودع', () => {
  assert.match(config.key, /^sb_publishable_/);
  assert.equal(config.bucket, 'signage');
  for (const file of ['src/signage-config.js', 'src/signage-api.js', 'screens.html', 'player.html']) {
    assert.doesNotMatch(read(file), /sb_secret_[A-Za-z0-9]|service_role|eyJhbGciOi/, file);
  }
});

test('الجداول والدوال التي تستخدمها الصفحات معرّفة في ملف القاعدة', () => {
  const sql = read('supabase/signage_setup.sql');
  const used = new Set();
  for (const file of ['src/signage-api.js', 'player.html']) {
    for (const m of read(file).matchAll(/\b(sg_[a-z_]+)\b/g)) used.add(m[1]);
  }
  assert.ok(used.has('sg_player_poll') && used.has('sg_replace_rules'));
  for (const name of used) assert.ok(sql.includes(`public.${name}`), `${name} معرّف في supabase/signage_setup.sql`);
});
