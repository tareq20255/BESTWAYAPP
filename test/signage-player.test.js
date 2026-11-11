const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// يشغّل سكربت player.html داخل متصفح وهمي صغير: DOM بالحد الأدنى، مؤقتات يتحكم فيها الاختبار، و XMLHttpRequest وهمي.
// الهدف اختبار منطق المشغّل (الاستعلام، تبديل القوائم، الانقطاع) لا الرسم نفسه.
const HTML = fs.readFileSync(path.join(__dirname, '..', 'player.html'), 'utf8');
const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(HTML)[1];
const VERSION = /PLAYER_VERSION = '([^']+)'/.exec(SCRIPT)[1];
const CONFIG = { url: 'https://proj.supabase.co', key: 'sb_publishable_test', bucket: 'signage' };
const DEVICE = 'testdevice0000000001';
const MEDIA = 'https://proj.supabase.co/storage/v1/object/public/signage/';

const Layout = require('../src/signage-layout');

// media: مقاس ومدة كل ملف بالرابط الكامل {w, h, seconds}. الافتراضي: صورة 1920×1080 وفيديو 360×640
function boot({ search = `?d=${DEVICE}`, stored = {}, videoSeconds = 30, failing = [], media = {}, width = 1920, height = 1080 } = {}) {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const setTimeout = (fn, ms) => { timers.set(++seq, { fn, at: now + (ms || 0) }); return seq; };
  const setInterval = (fn, ms) => { timers.set(++seq, { fn, at: now + ms, every: ms }); return seq; };
  const clear = (id) => { timers.delete(id); };
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
      if (!next) break;
      now = next.t.at;
      if (next.t.every) next.t.at += next.t.every; else timers.delete(next.id);
      next.t.fn();
    }
    now = end;
  }

  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.className = ''; this.attrs = {}; this.parentNode = null; this.textContent = ''; this.id = ''; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
    setAttribute(k, v) { this.attrs[k] = v; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'src') this.dead = true; }
    all() { return this.children.reduce((out, c) => out.concat(c, c.all()), []); }
    querySelector(sel) { return this.all().find((c) => (sel[0] === '#' ? c.id === sel.slice(1) : c.tag === sel)) || null; }
    querySelectorAll(sel) { return this.all().filter((c) => c.tag === sel); }
    // يكفي للقوالب البسيطة في المشغّل: وسوم متتالية بلا تداخل
    set innerHTML(html) {
      this.children = [];
      for (const m of html.matchAll(/<(\w+)(?: id="([^"]+)")?>([^<]*)/g)) {
        if (m[0][1] === '/') continue;
        const c = new El(m[1]); c.id = m[2] || ''; c.textContent = m[3]; this.appendChild(c);
      }
    }
    get innerHTML() { return ''; }
    set src(url) {
      this.url = url;
      if (url === 'about:blank') return;
      setTimeout(() => {
        if (this.dead) return;
        if (failing.includes(url)) { if (this.onerror) this.onerror(); return; }
        const m = media[url] || {};
        if (this.tag !== 'video') {
          this.naturalWidth = m.w || 1920; this.naturalHeight = m.h || 1080;
          if (this.onload) this.onload();
          return;
        }
        this.videoWidth = m.w || 360; this.videoHeight = m.h || 640; this.duration = m.seconds || videoSeconds;
        this.loaded = true;
        if (this.onloadedmetadata) this.onloadedmetadata();
        if (this.autoplay || this.wantPlay) this.begin();
      }, 1);
    }
    get src() { return this.url; }
    get currentTime() { return this.playing ? (now - this.started) / 1000 : 0; }
    // التشغيل يبدأ بعد التحميل عند autoplay أو استدعاء play()، ثم ينتهي الفيديو أو يتكرر حسب loop
    begin() {
      if (this.playing || this.dead) return;
      this.playing = true; this.started = now;
      if (this.onplaying) this.onplaying();
      const loopOrEnd = () => setTimeout(() => {
        if (this.dead) return;
        if (this.loop) { this.started = now; this.loops = (this.loops || 0) + 1; loopOrEnd(); } else if (this.onended) this.onended();
      }, this.duration * 1000);
      loopOrEnd();
    }
    play() { this.wantPlay = true; if (this.loaded) this.begin(); }
    pause() {} load() {}
  }
  const stage = new El('div'); stage.id = 'stage';
  const overlay = new El('div'); overlay.id = 'overlay';
  const net = new El('div'); net.id = 'net';
  const roots = [stage, overlay, net];
  const document = {
    hidden: false,
    getElementById: (id) => roots.find((r) => r.id === id) || roots.map((r) => r.querySelector(`#${id}`)).find(Boolean) || null,
    createElement: (tag) => new El(tag),
    addEventListener() {},
  };

  const ls = new Map(Object.entries(stored));
  const requests = [];
  const h = {
    respond: () => 'offline',   // يحدده الاختبار: كائن الرد، أو 'offline'، أو [status, body]
    pageVersion: VERSION,
    reloads: 0, replaced: null,
  };
  class Xhr {
    constructor() { this.headers = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) {
      const req = { method: this.method, url: this.url, headers: this.headers, body: body ? JSON.parse(body) : undefined, at: now };
      requests.push(req);
      setTimeout(() => {
        if (this.method === 'GET') { this.status = 200; this.responseText = `var PLAYER_VERSION = '${h.pageVersion}';`; this.onload(); return; }
        const out = h.respond(req);
        if (out === 'offline') { this.onerror(); return; }
        const [status, data] = Array.isArray(out) ? out : [200, out];
        this.status = status; this.responseText = JSON.stringify(data); this.onload();
      }, 5);
    }
  }
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(1_800_000_000_000 + now); }
    static now() { return 1_800_000_000_000 + now; }
  }
  const sandbox = {
    document, setTimeout, setInterval, clearTimeout: clear, clearInterval: clear, Date: FakeDate,
    XMLHttpRequest: Xhr,
    Image: class extends El { constructor() { super('img'); } },
    SIGNAGE_CONFIG: CONFIG,
    SignageLayout: Layout,
    innerWidth: width, innerHeight: height,
    navigator: {},
    location: { search, pathname: '/BESTWAYAPP/player.html', protocol: 'https:', reload() { h.reloads++; }, replace(u) { h.replaced = u; } },
    localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)) },
    addEventListener() {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SCRIPT, sandbox);

  const polls = () => requests.filter((r) => r.method === 'POST');
  // ما يراه المشاهد الآن: آخر طبقة ظاهرة، أو حالة الصفحة الجانبية
  function shown() {
    const layer = stage.children.filter((l) => l.className.includes('show')).pop();
    if (!layer) return overlay.className === 'on' ? `overlay:${(overlay.querySelector('#code') || overlay.querySelector('h1') || {}).textContent}` : null;
    if (layer.className.includes('group')) { // المجموعة توصف بشبكتها: صفوف × أعمدة
      const count = (key) => new Set(layer.children.map((cell) => cell.style[key])).size;
      return `group:${count('top')}x${count('right')}`;
    }
    const el = layer.children[0];
    return el ? `${el.tag}:${el.url.replace(MEDIA, '')}` : `text:${layer.textContent}`;
  }
  // يسجّل تسلسل ما عُرض خلال مدة
  function watch(ms, step = 250) {
    const seen = [];
    for (let t = 0; t < ms; t += step) {
      advance(step);
      const s = shown();
      if (s && seen[seen.length - 1] !== s) seen.push(s);
    }
    return seen;
  }
  return Object.assign(h, { advance, watch, shown, polls, requests, ls, stage, overlay, net });
}

let stamp = 0;
const item = (id, type, extra) => Object.assign({ id, type, file: null, url: null, text: null, bg: '#111111', fg: '#ffffff', fit: 'contain', duration: 10, updated: 1000 + id }, extra);
const text = (id, body, duration = 10) => item(id, 'text', { text: body, duration });
const image = (id, file, duration = 10) => item(id, 'image', { file, duration });
const video = (id, file) => item(id, 'video', { file });
const group = (id, parts, extra) => item(id, 'group', Object.assign({ parts: parts.map((file) => ({ file, kind: /\.mp4$/.test(file) ? 'video' : 'image' })) }, extra));
const playlist = (items, name = 'كاشير 1') => ({ paired: true, name, version: `v${++stamp}`, items, now: '2026-11-11T12:00:00' });

test('الاستعلام: دالة sg_player_poll بالمفتاح في apikey فقط ومعرّف الجهاز', () => {
  const p = boot();
  p.respond = () => playlist([]);
  p.advance(100);
  const [req] = p.polls();
  assert.equal(req.url, 'https://proj.supabase.co/rest/v1/rpc/sg_player_poll');
  assert.deepEqual(req.headers, { apikey: CONFIG.key, 'Content-Type': 'application/json' });
  assert.deepEqual(req.body, { p_device_id: DEVICE, p_hb: true, p_w: 1920, p_h: 1080, p_version: null }, 'مقاس الشاشة وإصدار قائمتها مع الاستعلام');
  assert.equal(p.shown(), 'overlay:كاشير 1', 'قائمة فارغة: اسم الشاشة والساعة');
  p.advance(60_000);
  assert.equal(p.polls().length, 2, 'استعلام كل دقيقة');
});

test('معرّف الشاشة: يتولد ويُحفظ، و hb=0 للمعاينة، و reset يمسحه، والرابط التالف مرفوض', () => {
  const fresh = boot({ search: '' });
  fresh.advance(100);
  const id = fresh.polls()[0].body.p_device_id;
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(fresh.ls.get('bw-signage:device'), id);
  const again = boot({ search: '', stored: { 'bw-signage:device': id } });
  again.advance(100);
  assert.equal(again.polls()[0].body.p_device_id, id, 'نفس المعرّف بعد إعادة التشغيل');

  const preview = boot({ search: `?d=${DEVICE}&hb=0` });
  preview.advance(100);
  assert.equal(preview.polls()[0].body.p_hb, false);
  assert.equal(preview.ls.has('bw-signage:device'), false, 'رابط المعاينة لا يغيّر معرّف الجهاز المحفوظ');

  const reset = boot({ search: '?reset=1', stored: { 'bw-signage:device': id, 'bw-signage:playlist': '{}' } });
  reset.advance(100);
  assert.equal(reset.ls.get('bw-signage:device'), '');
  assert.equal(reset.replaced, '/BESTWAYAPP/player.html');
  assert.equal(reset.polls().length, 0);

  const bad = boot({ search: '?d=short' });
  bad.advance(100_000);
  assert.match(bad.shown(), /الرابط ده غير صحيح/);
  assert.equal(bad.polls().length, 0);
});

test('شاشة غير مربوطة: تعرض الكود وتسأل كل 5 ثوانٍ ثم كل 30، وبعد الربط تبدأ العرض', () => {
  const p = boot({ search: '' });
  p.respond = () => ({ paired: false, code: '482916' });
  p.advance(100);
  assert.equal(p.shown(), 'overlay:482916');
  p.advance(60_000);
  assert.ok(p.polls().length >= 12 && p.polls().length <= 13, `كل 5 ثوانٍ: ${p.polls().length}`);
  p.advance(600_000);
  const before = p.polls().length;
  p.advance(300_000);
  assert.ok(p.polls().length - before <= 11, 'بعد عشر دقائق: كل 30 ثانية');
  p.respond = () => playlist([text(1, 'أهلًا')]);
  p.advance(31_000);
  assert.equal(p.shown(), 'text:أهلًا');
});

for (const [name, first, expected] of [
  ['نص', text(1, 'اول'), 'text:اول'],
  ['صورة', image(1, 'c/a.jpg'), 'img:c/a.jpg'],
  ['فيديو يتكرر', video(1, 'c/v.mp4'), 'video:c/v.mp4'],
]) {
  test(`عنصر وحيد (${name}) ثم إضافة عنصر ثانٍ: الشاشة تبدأ التبادل بلا إعادة تحميل`, () => {
    const p = boot({ videoSeconds: 30 });
    p.respond = () => playlist([first]);
    p.advance(100);
    assert.deepEqual(p.watch(200_000), [expected], 'العنصر الوحيد يبقى معروضًا');
    p.respond = () => playlist([first, text(2, 'تاني')]);
    const seen = p.watch(200_000);
    assert.deepEqual(seen.slice(0, 4), [expected, 'text:تاني', expected, 'text:تاني'], seen.join(' → '));
  });
}

test('فيديو وحيد أُضيف له عنصر: يكمل دورته الحالية ولا يُقطع', () => {
  const p = boot({ videoSeconds: 30 });
  p.respond = () => playlist([video(1, 'c/v.mp4')]);
  p.advance(100);
  const el = p.stage.children[0].children[0];
  assert.equal(el.loop, true);
  p.respond = () => playlist([video(1, 'c/v.mp4'), text(2, 'تاني')]);
  p.advance(60_000); // الاستعلام التالي
  assert.equal(el.loop, false);
  assert.equal(p.shown(), 'video:c/v.mp4', 'ما زال يعرض نفس الفيديو');
  assert.equal(p.stage.children[0].children[0], el, 'نفس عنصر الفيديو لم يُستبدل');
  p.advance(30_000);
  assert.equal(p.shown(), 'text:تاني', 'انتقل عند انتهاء الفيديو');
});

test('قائمة من عنصرين ثم حذف أحدهما: يبقى الآخر وحده', () => {
  const p = boot();
  p.respond = () => playlist([text(1, 'اول', 5), text(2, 'تاني', 5)]);
  p.advance(100);
  assert.deepEqual(p.watch(21_000).slice(0, 4), ['text:اول', 'text:تاني', 'text:اول', 'text:تاني']);
  p.respond = () => playlist([text(2, 'تاني', 5)]);
  p.advance(120_000);
  assert.deepEqual(p.watch(120_000), ['text:تاني']);
  assert.equal(p.stage.children.length, 1, 'لا طبقات متراكمة');
});

test('نفس الإصدار لا يقطع العرض، وتعديل العنصر المعروض يعيد تشغيل القائمة', () => {
  const p = boot();
  const same = playlist([text(1, 'اول', 3600), text(2, 'تاني', 3600)]);
  p.respond = () => same;
  p.advance(100);
  const layer = p.stage.children[0];
  p.advance(180_000);
  assert.equal(p.stage.children[0], layer, 'نفس الطبقة بعد ثلاثة استعلامات');
  // قائمة جديدة والعنصر المعروض لم يتغير: يكمل
  p.respond = () => playlist([text(1, 'اول', 3600), text(3, 'تالت', 3600)]);
  p.advance(60_000);
  assert.equal(p.stage.children[0], layer);
  // العنصر المعروض نفسه اتعدّل (updated مختلف): يُعاد من أول القائمة
  p.respond = () => playlist([Object.assign(text(1, 'اول معدّل', 3600), { updated: 9999 }), text(3, 'تالت', 3600)]);
  p.advance(61_000);
  assert.equal(p.shown(), 'text:اول معدّل');
});

test('صورة لا تُحمَّل تُتخطى ويستمر الباقي', () => {
  const p = boot({ failing: [`${MEDIA}c/missing.jpg`] });
  p.respond = () => playlist([image(1, 'c/missing.jpg', 5), text(2, 'تاني', 5)]);
  p.advance(100);
  const seen = p.watch(30_000);
  assert.ok(seen.includes('text:تاني'), seen.join(' → '));
  assert.ok(!seen.some((s) => s.includes('missing')), 'الصورة المعطوبة لا تظهر');
});

test('بدون إنترنت: يبدأ بآخر قائمة محفوظة، تظهر علامة الانقطاع، ثم يتعافى', () => {
  const online = boot();
  const list = playlist([text(1, 'اول', 5), text(2, 'تاني', 5)]);
  online.respond = () => list;
  online.advance(100);
  const saved = online.ls.get('bw-signage:playlist');
  assert.equal(JSON.parse(saved).device, DEVICE);

  const p = boot({ stored: { 'bw-signage:playlist': saved } }); // إعادة تشغيل بلا إنترنت
  assert.equal(p.shown(), 'text:اول', 'العرض يبدأ فورًا قبل أي رد');
  p.advance(100);
  assert.equal(p.net.className, '', 'فشل واحد لا يكفي');
  p.advance(16_000);
  assert.equal(p.net.className, 'on');
  assert.ok(p.watch(20_000).includes('text:تاني'), 'التبادل مستمر بلا إنترنت');
  p.respond = () => list; // رجع الإنترنت ونفس الإصدار
  const layers = p.stage.children.length;
  p.advance(16_000);
  assert.equal(p.net.className, '');
  assert.ok(p.stage.children.length <= layers, 'نفس الإصدار: لا إعادة تشغيل');

  const other = boot({ search: '?d=otherdevice000000001', stored: { 'bw-signage:playlist': saved } });
  assert.equal(other.shown(), null, 'قائمة شاشة أخرى لا تُستخدم');
});

test('شاشة حُذفت من الإدارة: ترجع لصفحة الكود وتمسح قائمتها المحفوظة', () => {
  const p = boot();
  p.respond = () => playlist([text(1, 'اول')]);
  p.advance(100);
  assert.equal(p.shown(), 'text:اول');
  p.respond = () => ({ paired: false, code: '111222' });
  p.advance(60_000);
  assert.equal(p.shown(), 'overlay:111222');
  assert.equal(p.stage.children.length, 0);
  assert.equal(p.ls.get('bw-signage:playlist'), '');
  // أُعيد ربطها بنفس القائمة: يبدأ العرض من جديد
  p.respond = () => playlist([text(1, 'اول')]);
  p.advance(6_000);
  assert.equal(p.shown(), 'text:اول');
});

test('قائمة الأكواد ممتلئة: رسالة واضحة بدل شاشة سوداء', () => {
  const p = boot({ search: '' });
  p.respond = () => [400, { code: 'P0001', message: 'too many pending devices' }];
  p.advance(100);
  assert.match(p.shown(), /مسح الأكواد/);
  assert.equal(p.net.className, '', 'ليس انقطاعًا');
});

test('تحديث الصفحة: إعادة تحميل لو تغيّر PLAYER_VERSION على السيرفر فقط', () => {
  const same = boot();
  same.respond = () => playlist([text(1, 'اول')]);
  same.advance(7 * 3600_000);
  assert.ok(same.requests.some((r) => r.method === 'GET' && r.url === '/BESTWAYAPP/player.html'), 'فحص الإصدار كل 6 ساعات');
  assert.equal(same.reloads, 0);

  const newer = boot();
  newer.respond = () => playlist([text(1, 'اول')]);
  newer.advance(5 * 3600_000);
  assert.equal(newer.requests.filter((r) => r.method === 'GET').length, 0, 'لا فحص قبل 6 ساعات');
  newer.pageVersion = '99.0.0';
  newer.advance(2 * 3600_000);
  assert.equal(newer.reloads, 1);
});

test('رد مختصر: الشاشة ترسل إصدار قائمتها، و unchanged لا يقطع العرض', () => {
  const p = boot();
  const list = playlist([text(1, 'اول', 3600), text(2, 'تاني', 3600)]);
  p.respond = (req) => (req.body.p_version === list.version ? { paired: true, unchanged: true, version: list.version } : list);
  p.advance(100);
  const layer = p.stage.children[0];
  p.advance(180_000);
  assert.deepEqual(p.polls().map((r) => r.body.p_version), [null, list.version, list.version, list.version]);
  assert.equal(p.stage.children[0], layer, 'نفس الطبقة');
  assert.equal(p.net.className, '');
  // تغيّرت القائمة: يرجع الرد الكامل ويُطبَّق
  const next = playlist([text(3, 'جديد')]);
  p.respond = () => next;
  p.advance(61_000);
  assert.equal(p.shown(), 'text:جديد');
  p.advance(60_000);
  assert.equal(p.polls().pop().body.p_version, next.version);
});

test('قاعدة لم تأخذ تحديث 2: المشغّل يرجع للاستعلام القديم ويكمل', () => {
  const p = boot();
  p.respond = (req) => ('p_version' in req.body
    ? [404, { code: 'PGRST202', message: 'Could not find the function public.sg_player_poll(p_device_id, p_h, p_hb, p_version, p_w) in the schema cache' }]
    : playlist([text(1, 'اول')]));
  p.advance(100);
  assert.equal(p.shown(), 'text:اول');
  assert.equal(p.net.className, '', 'ليس انقطاعًا');
  p.advance(120_000);
  const bodies = p.polls().map((r) => Object.keys(r.body).join(','));
  assert.equal(bodies[0], 'p_device_id,p_hb,p_w,p_h,p_version');
  assert.ok(bodies.slice(1).every((b) => b === 'p_device_id,p_hb'), 'بعد أول رفض: المعاملان القديمان فقط');
  assert.equal(p.polls().length, 4, 'محاولة واحدة فاشلة ثم استعلام كل دقيقة');
});

test('مجموعة من 3 فيديوهات طولية على شاشة عرضية: صف من ثلاثة، وتنتقل عند انتهاء أطولها', () => {
  const media = { [`${MEDIA}c/a.mp4`]: { seconds: 10 }, [`${MEDIA}c/b.mp4`]: { seconds: 14 }, [`${MEDIA}c/c.mp4`]: { seconds: 6 } };
  const p = boot({ media });
  p.respond = () => playlist([group(1, ['c/a.mp4', 'c/b.mp4', 'c/c.mp4'], { fit: 'cover' }), text(2, 'تاني', 5)]);
  p.advance(100);
  assert.equal(p.shown(), 'group:1x3');
  const cells = p.stage.children[0].children;
  assert.deepEqual(cells.map((c) => [Math.round(parseFloat(c.style.right)), Math.round(parseFloat(c.style.width)), c.style.height]), [[0, 33, '100%'], [33, 33, '100%'], [67, 33, '100%']]);
  const videos = cells.map((c) => c.children[0]);
  assert.deepEqual(videos.map((v) => v.url.replace(MEDIA, '')), ['c/a.mp4', 'c/b.mp4', 'c/c.mp4'], 'الأول على اليمين');
  assert.ok(videos.every((v) => v.playing && v.muted && v.style.objectFit === 'cover'));
  assert.deepEqual(videos.map((v) => v.loop), [true, false, true], 'الأطول لا يتكرر والباقي يتكرر حتى ينتهي');
  p.advance(13_000);
  assert.equal(p.shown(), 'group:1x3', 'ما زالت معروضة قبل انتهاء الأطول');
  assert.equal(videos[2].loops, 2, 'القصير تكرر');
  p.advance(2_000);
  assert.equal(p.shown(), 'text:تاني');
  p.advance(6_000);
  assert.equal(p.shown(), 'group:1x3', 'رجعت في دورها');
});

test('المجموعة تختار شبكتها من مقاس الشاشة والملفات', () => {
  const wide = (name) => ({ [`${MEDIA}c/${name}`]: { w: 1920, h: 1080 } });
  const landscapeImages = Object.assign({}, wide('a.jpg'), wide('b.jpg'), wide('c.jpg'), wide('d.jpg'));
  const tall = boot({ media: landscapeImages, width: 1080, height: 1920 });
  tall.respond = () => playlist([group(1, ['c/a.jpg', 'c/b.jpg', 'c/c.jpg'])]);
  tall.advance(100);
  assert.equal(tall.shown(), 'group:3x1', 'ثلاث صور عرضية فوق بعض على شاشة طولية');
  assert.equal(tall.polls()[0].body.p_w, 1080);

  const four = boot({ media: landscapeImages });
  four.respond = () => playlist([group(1, ['c/a.jpg', 'c/b.jpg', 'c/c.jpg', 'c/d.jpg'])]);
  four.advance(100);
  assert.equal(four.shown(), 'group:2x2', 'أربع صور عرضية: شبكة 2×2 على شاشة عرضية');

  // صور فقط: تنتقل بعد مدتها
  const timed = boot({ media: landscapeImages });
  timed.respond = () => playlist([group(1, ['c/a.jpg', 'c/b.jpg'], { duration: 7 }), text(2, 'تاني', 5)]);
  timed.advance(100);
  assert.deepEqual(timed.watch(20_000).slice(0, 3), ['group:1x2', 'text:تاني', 'group:1x2']);
});

test('مجموعة وحدها تتكرر، ولما يُضاف محتوى تدخل في التبادل', () => {
  const p = boot({ videoSeconds: 10 });
  const g = group(1, ['c/a.mp4', 'c/b.mp4']);
  p.respond = () => playlist([g]);
  p.advance(100);
  assert.deepEqual(p.watch(100_000), ['group:1x2']);
  assert.ok(p.stage.children[0].children.every((c) => c.children[0].loop), 'وحدها: كل الفيديوهات تتكرر');
  p.respond = () => playlist([g, text(2, 'تاني', 5)]);
  const seen = p.watch(100_000);
  assert.deepEqual(seen.slice(0, 4), ['group:1x2', 'text:تاني', 'group:1x2', 'text:تاني'], seen.join(' → '));
  assert.ok(p.stage.children.length <= 2, 'لا طبقات متراكمة');
});

test('مجموعة فيها ملف لا يُحمَّل تُتخطى كلها، والنوع غير المعروف لا يوقف الشاشة', () => {
  const p = boot({ failing: [`${MEDIA}c/missing.mp4`] });
  p.respond = () => playlist([group(1, ['c/a.mp4', 'c/missing.mp4']), text(2, 'تاني', 5)]);
  p.advance(100);
  const seen = p.watch(30_000);
  assert.ok(seen.includes('text:تاني') && !seen.some((s) => s.startsWith('group')), seen.join(' → '));
  assert.equal(p.stage.children.filter((l) => l.className.includes('group')).length, 0, 'لا بقايا للمجموعة المعطوبة');

  const future = boot();
  future.respond = () => playlist([item(1, 'hologram')]);
  future.advance(200_000); // لا تكرار لا نهائي ولا توقف للاستعلام
  assert.ok(future.polls().length >= 3);
  future.respond = () => playlist([text(2, 'تاني')]);
  future.advance(61_000);
  assert.equal(future.shown(), 'text:تاني');
});
