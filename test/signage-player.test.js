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

function boot({ search = `?d=${DEVICE}`, stored = {}, videoSeconds = 30, failing = [] } = {}) {
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
        if (this.tag !== 'video') { if (this.onload) this.onload(); return; }
        this.duration = videoSeconds; this.started = now;
        this.onloadedmetadata(); this.onplaying();
        const loopOrEnd = () => setTimeout(() => {
          if (this.dead) return;
          if (this.loop) { this.started = now; loopOrEnd(); } else this.onended();
        }, videoSeconds * 1000);
        loopOrEnd();
      }, 1);
    }
    get src() { return this.url; }
    get currentTime() { return (now - this.started) / 1000; }
    play() {} pause() {} load() {}
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
    const media = layer.children[0];
    return media ? `${media.tag}:${media.url.replace(MEDIA, '')}` : `text:${layer.textContent}`;
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
const playlist = (items, name = 'كاشير 1') => ({ paired: true, name, version: `v${++stamp}`, items, now: '2026-11-11T12:00:00' });

test('الاستعلام: دالة sg_player_poll بالمفتاح في apikey فقط ومعرّف الجهاز', () => {
  const p = boot();
  p.respond = () => playlist([]);
  p.advance(100);
  const [req] = p.polls();
  assert.equal(req.url, 'https://proj.supabase.co/rest/v1/rpc/sg_player_poll');
  assert.deepEqual(req.headers, { apikey: CONFIG.key, 'Content-Type': 'application/json' });
  assert.deepEqual(req.body, { p_device_id: DEVICE, p_hb: true });
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
