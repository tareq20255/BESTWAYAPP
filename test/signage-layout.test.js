const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../src/signage-layout');

const TALL = 9 / 16;
const WIDE = 16 / 9;
const grid = (aspects, w, h) => { const g = layout.choose(aspects, w, h); return `${g.rows}x${g.cols}`; };

test('choose: الشبكة الأكثر تغطية للشاشة', () => {
  assert.equal(grid([TALL, TALL, TALL], 1920, 1080), '1x3', 'ثلاثة طولية جنب بعض على العرضية');
  assert.ok(layout.choose([TALL, TALL, TALL], 1920, 1080).fill > 0.94);
  assert.equal(grid([TALL, TALL], 1920, 1080), '1x2');
  assert.equal(grid([TALL, TALL, TALL, TALL], 1920, 1080), '1x4', 'أربعة طولية: صف أفضل من 2×2');
  assert.equal(grid([WIDE, WIDE, WIDE, WIDE], 1920, 1080), '2x2');
  assert.ok(Math.abs(layout.choose([WIDE, WIDE, WIDE, WIDE], 1920, 1080).fill - 1) < 1e-9);
  assert.equal(grid([WIDE, WIDE, WIDE], 1080, 1920), '3x1', 'ثلاثة عرضية فوق بعض على الطولية');
  assert.equal(grid([WIDE, WIDE], 1080, 1920), '2x1');
  assert.equal(grid([TALL, TALL, TALL, TALL], 1080, 1920), '2x2');
});

test('choose: عند التعادل صف على العرضية وعمود على الطولية، والنسبة المجهولة لا تكسر الحساب', () => {
  assert.equal(grid([WIDE, WIDE], 1920, 1080), '1x2');
  assert.equal(grid([TALL, TALL], 1080, 1920), '2x1');
  assert.equal(grid([0, 0, 0], 1920, 1080), '1x3');
  assert.equal(grid([0, 0, 0], 1080, 1920), '3x1');
  const g = layout.choose([0, NaN, undefined], 1920, 1080);
  assert.ok(g.fill > 0.99 && g.fill < 1.01);
});

test('fill: نسبة التغطية بلا قص', () => {
  assert.ok(Math.abs(layout.fill([TALL], 1920, 1080, 1, 1) - (1080 * TALL * 1080) / (1920 * 1080)) < 1e-9);
  assert.ok(Math.abs(layout.fill([WIDE], 1920, 1080, 1, 1) - 1) < 1e-9);
  assert.ok(layout.fill([TALL, TALL, TALL], 1920, 1080, 3, 1) < 0.2, 'طولية فوق بعض على العرضية: أسوأ توزيع');
});

test('cells: مواضع بالنسبة المئوية، الأول على اليمين، صفًا بصف', () => {
  assert.deepEqual(layout.cells(2, 1, 2), [{ right: 0, top: 0, width: 50, height: 100 }, { right: 50, top: 0, width: 50, height: 100 }]);
  assert.deepEqual(layout.cells(3, 3, 1).map((c) => [c.right, Math.round(c.top), c.width, Math.round(c.height)]), [[0, 0, 100, 33], [0, 33, 100, 33], [0, 67, 100, 33]]);
  assert.deepEqual(layout.cells(4, 2, 2).map((c) => [c.right, c.top]), [[0, 0], [50, 0], [0, 50], [50, 50]]);
});
