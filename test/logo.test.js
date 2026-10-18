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
    { URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => revoked++ }, Image: BadImage, document: {} }
  );
  assert.deepEqual(r, { ok: false, reason: 'decode' });
  assert.equal(revoked, 1);
});

test('logoMessage: رسالة مختلفة لكل سبب', () => {
  const m = ['not-image', 'too-big', 'too-large-output', 'decode'].map(logo.logoMessage);
  assert.equal(new Set(m).size, 4);
});
