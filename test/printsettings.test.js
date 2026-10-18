const test = require('node:test');
const assert = require('node:assert/strict');
const ps = require('../src/printsettings');

test('الافتراضي: 58 مم ← 384 نقطة، و75 و80 مم ← 576', () => {
  assert.equal(ps.dotsFor({}, '58'), 384);
  assert.equal(ps.dotsFor({}, '75'), 576);
  assert.equal(ps.dotsFor({}, '80'), 576);
  assert.equal(ps.dotsFor(undefined, '58'), 384);
  assert.equal(ps.dotsFor({}, 'غير معروف'), 576);
});

test('cleanSettings: قيم معروفة فقط ومع افتراضيات', () => {
  assert.deepEqual(ps.cleanSettings(undefined), { paper: '75', dotsByPaper: {} });
  assert.deepEqual(ps.cleanSettings({ paper: 58, dotsByPaper: { 58: 384, 80: 999, 75: 'x', evil: 640 } }), {
    paper: '58',
    dotsByPaper: { 58: 384 },
  });
  assert.equal(ps.cleanSettings({ paper: '100' }).paper, '75');
});

test('withPaper: يغيّر الورق فقط ويحافظ على اختيارات النقاط', () => {
  const s = ps.withDots({}, '80', 640);
  const next = ps.withPaper(s, '58');
  assert.equal(next.paper, '58');
  assert.equal(next.dotsByPaper['80'], 640);
  assert.equal(ps.withPaper(s, 'x').paper, '75');
});

test('withDots: اختيار يدوي يُحفظ لذلك الورق ويعود عند اختياره من جديد', () => {
  let s = ps.withDots(ps.withPaper({}, '80'), '80', 640);
  assert.equal(ps.dotsFor(s, '80'), 640);
  assert.equal(ps.dotsFor(s, '58'), 384); // ورق آخر يبقى على تلقائيه
  s = ps.withPaper(s, '58');
  assert.equal(ps.dotsFor(s, '58'), 384);
  s = ps.withPaper(s, '80');
  assert.equal(ps.dotsFor(s, '80'), 640);
});

test('withDots: قيمة أو ورق غير مسموح لا يغيّران شيئًا', () => {
  const s = ps.withPaper({}, '58');
  assert.deepEqual(ps.withDots(s, '58', 999), s);
  assert.deepEqual(ps.withDots(s, '100', 576), s);
});

test('withDots/withPaper: لا يعدّلان الكائن الأصلي', () => {
  const s = Object.freeze({ paper: '75', dotsByPaper: Object.freeze({}) });
  assert.doesNotThrow(() => ps.withDots(s, '75', 640));
  assert.doesNotThrow(() => ps.withPaper(s, '58'));
});

test('load/save: بدون localStorage أو ببيانات تالفة يرجع الافتراضي ولا يرمي', () => {
  assert.deepEqual(ps.loadPrintSettings(), { paper: '75', dotsByPaper: {} });
  assert.doesNotThrow(() => ps.savePrintSettings({ paper: '58' }));
  global.localStorage = { getItem: () => '{not json', setItem() { throw new Error('quota'); } };
  try {
    assert.deepEqual(ps.loadPrintSettings(), { paper: '75', dotsByPaper: {} });
    assert.doesNotThrow(() => ps.savePrintSettings({ paper: '58' }));
    const store = {};
    global.localStorage = { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } };
    ps.savePrintSettings(ps.withDots(ps.withPaper({}, '58'), '58', 384));
    assert.deepEqual(ps.loadPrintSettings(), { paper: '58', dotsByPaper: { 58: 384 } });
  } finally {
    delete global.localStorage;
  }
});
