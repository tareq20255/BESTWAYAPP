const test = require('node:test');
const assert = require('node:assert/strict');
const logo = require('../src/logo');

// يبني RGBA من دالة (x, y) → [r, g, b, a]
function image(w, h, pixel) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set(pixel(x, y), (y * w + x) * 4);
  }
  return data;
}
const at = (data, w, x, y) => data[(y * w + x) * 4];

test('fitSize: يصغّر مع الحفاظ على النسبة ولا يكبّر', () => {
  assert.deepEqual(logo.fitSize(768, 384), { w: 384, h: 192 });
  assert.deepEqual(logo.fitSize(1000, 100), { w: 384, h: 38 });
  assert.deepEqual(logo.fitSize(200, 800), { w: 48, h: 192 });
  assert.deepEqual(logo.fitSize(100, 50), { w: 100, h: 50 });
  assert.deepEqual(logo.fitSize(1, 1000), { w: 1, h: 192 });
});

test('toGrayscale: الشفافية تُحسب فوق خلفية بيضاء', () => {
  const gray = logo.toGrayscale(Uint8ClampedArray.from([0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 128]));
  assert.deepEqual([...gray], [0, 255, 255, 127]);
});

test('otsuThreshold: يفصل قمّتين (داكن وفاتح)', () => {
  const gray = new Uint8Array(200);
  gray.fill(30, 0, 100);
  gray.fill(220, 100);
  const t = logo.otsuThreshold(gray);
  assert.ok(t >= 30 && t < 220, `threshold=${t}`);
});

test('toMonochrome: مربع أسود على خلفية بيضاء يبقى كما هو', () => {
  const w = 10;
  const px = image(w, 10, (x, y) => (x >= 3 && x < 7 && y >= 3 && y < 7 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const { data } = logo.toMonochrome(px);
  assert.equal(at(data, w, 4, 4), 0);
  assert.equal(at(data, w, 0, 0), 255);
  assert.ok([...data].every((v, i) => i % 4 === 3 ? v === 255 : v === 0 || v === 255));
});

test('toMonochrome: خلفية شفافة تصير بيضاء والألوان المتوسطة تُحسم أسود/أبيض', () => {
  const w = 6;
  const px = image(w, 2, (x) => (x < 2 ? [0, 0, 0, 0] : x < 4 ? [200, 30, 30, 255] : [250, 250, 250, 255]));
  const { data } = logo.toMonochrome(px);
  assert.equal(at(data, w, 0, 0), 255); // شفاف → أبيض
  assert.equal(at(data, w, 2, 0), 0); // أحمر داكن → أسود
  assert.equal(at(data, w, 5, 0), 255);
});

test('toMonochrome: صورة بلون واحد: فاتحة بيضاء وداكنة سوداء', () => {
  const light = logo.toMonochrome(image(4, 4, () => [240, 240, 240, 255])).data;
  const dark = logo.toMonochrome(image(4, 4, () => [20, 20, 20, 255])).data;
  assert.ok([...light].filter((_, i) => i % 4 === 0).every((v) => v === 255));
  assert.ok([...dark].filter((_, i) => i % 4 === 0).every((v) => v === 0));
});

test('processLogoFile: يرفض ما ليس صورة أو الكبير جدًا قبل أي معالجة', async () => {
  assert.deepEqual(await logo.processLogoFile({ type: 'text/plain', size: 10 }), { ok: false, reason: 'not-image' });
  assert.deepEqual(await logo.processLogoFile(null), { ok: false, reason: 'not-image' });
  assert.deepEqual(await logo.processLogoFile({ type: 'image/png', size: 6 * 1024 * 1024 }), { ok: false, reason: 'too-big' });
});

test('processLogoFile: صورة تالفة ترجع decode وتحرّر الرابط المؤقت', async () => {
  let revoked = 0;
  class BadImage {
    set src(_) { queueMicrotask(() => this.onerror()); }
  }
  const r = await logo.processLogoFile(
    { type: 'image/png', size: 10 },
    {},
    { URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => revoked++ }, Image: BadImage, document: {} }
  );
  assert.deepEqual(r, { ok: false, reason: 'decode' });
  assert.equal(revoked, 1);
});

test('logoMessage: رسالة مختلفة لكل سبب', () => {
  const m = ['not-image', 'too-big', 'too-large-output', 'decode'].map(logo.logoMessage);
  assert.equal(new Set(m).size, 4);
});

// تدرّج أفقي من الأسود إلى الأبيض (w × h)
const ramp = (w, h) => image(w, h, (x) => { const v = Math.round((x / (w - 1)) * 255); return [v, v, v, 255]; });
const blackShare = (data, from, to, w, h) => {
  let black = 0;
  let total = 0;
  for (let y = 0; y < h; y++) for (let x = from; x < to; x++) { total++; if (data[(y * w + x) * 4] === 0) black++; }
  return black / total;
};

test('ditherFloydSteinberg: ناتج 0/255 فقط وحتمي، والرمادي المتوسط ≈ نصف أسود', () => {
  const gray = new Uint8Array(64 * 64).fill(128);
  const a = logo.ditherFloydSteinberg(gray, 64);
  const b = logo.ditherFloydSteinberg(gray, 64);
  assert.ok(a.every((v) => v === 0 || v === 255));
  assert.deepEqual([...a], [...b]);
  const black = a.filter((v) => v === 0).length / a.length;
  assert.ok(black > 0.4 && black < 0.6, `black=${black}`);
});

test('toMonochrome (تنقيط): التدرّج يتحول لكثافة نقاط تتناقص من الأسود للأبيض', () => {
  const w = 64;
  const h = 16;
  const { data } = logo.toMonochrome(ramp(w, h), { mode: 'dither', width: w });
  assert.ok([...data].every((v, i) => (i % 4 === 3 ? v === 255 : v === 0 || v === 255)));
  const left = blackShare(data, 0, 16, w, h);
  const mid = blackShare(data, 24, 40, w, h);
  const right = blackShare(data, 48, 64, w, h);
  assert.ok(left > mid && mid > right, `${left} ${mid} ${right}`);
  assert.ok(left > 0.7 && right < 0.3);
});

test('toMonochrome: الحاد يحسم التدرّج لكتلتين، والتنقيط لا يفعل', () => {
  const w = 64;
  const h = 8;
  const sharp = logo.toMonochrome(ramp(w, h), { mode: 'threshold' }).data;
  // الحاد: أسود ثم أبيض بحدّ واحد في كل صف
  let flips = 0;
  for (let x = 1; x < w; x++) if (sharp[x * 4] !== sharp[(x - 1) * 4]) flips++;
  assert.equal(flips, 1);
  const dith = logo.toMonochrome(ramp(w, h), { mode: 'dither', width: w }).data;
  let dflips = 0;
  for (let x = 1; x < w; x++) if (dith[x * 4] !== dith[(x - 1) * 4]) dflips++;
  assert.ok(dflips > 3);
});

test('toMonochrome: عكس الألوان يقلب الأسود والأبيض في النمطين', () => {
  const w = 10;
  const px = image(w, 10, (x, y) => (x >= 3 && x < 7 && y >= 3 && y < 7 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  for (const mode of ['threshold', 'dither']) {
    const normal = logo.toMonochrome(px, { mode, width: w }).data;
    const inv = logo.toMonochrome(px, { mode, width: w, invert: true }).data;
    assert.equal(at(normal, w, 4, 4), 0);
    assert.equal(at(inv, w, 4, 4), 255);
    assert.equal(at(normal, w, 0, 0), 255);
    assert.equal(at(inv, w, 0, 0), 0);
  }
});

test('toMonochrome (تنقيط): صورة بلون واحد لا تتحول لنقاط', () => {
  const light = logo.toMonochrome(image(8, 8, () => [240, 240, 240, 255]), { mode: 'dither', width: 8 }).data;
  const dark = logo.toMonochrome(image(8, 8, () => [20, 20, 20, 255]), { mode: 'dither', width: 8 }).data;
  assert.ok([...light].filter((_, i) => i % 4 === 0).every((v) => v === 255));
  assert.ok([...dark].filter((_, i) => i % 4 === 0).every((v) => v === 0));
});

test('toMonochrome (تنقيط): يتطلب width', () => {
  assert.throws(() => logo.toMonochrome(ramp(8, 8), { mode: 'dither' }), /width/);
});

test('toMonochrome: نمط غير معروف يُعامل كحاد (الافتراضي)', () => {
  const a = logo.toMonochrome(ramp(16, 4)).data;
  const b = logo.toMonochrome(ramp(16, 4), { mode: 'whatever' }).data;
  assert.deepEqual([...a], [...b]);
});

test('reprocessLogo: يرفض ما ليس نسخة رمادية JPEG من data:', async () => {
  for (const bad of ['', null, undefined, 'https://x/y.jpg', 'data:image/png;base64,AAAA', 5]) {
    assert.deepEqual(await logo.reprocessLogo(bad), { ok: false, reason: 'not-image' }, String(bad));
  }
});

test('reprocessLogo: صورة تالفة ترجع decode', async () => {
  class BadImage {
    set src(_) { queueMicrotask(() => this.onerror()); }
  }
  const r = await logo.reprocessLogo('data:image/jpeg;base64,AAAA', {}, { Image: BadImage, document: {} });
  assert.deepEqual(r, { ok: false, reason: 'decode' });
});
