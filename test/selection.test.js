const test = require('node:test');
const assert = require('node:assert/strict');
const sel = require('../src/selection');
const { parseMessage } = require('../src/parser');

const order = (ref, extra = '') =>
  `*BESTWAY · ONLINE ORDER*\n${ref ? `Ref: ${ref}\n` : ''}• 1× 100420 Garlic ${extra}45 EGP\nTotal: 45 EGP`;
const three = [order('BW-1'), order('BW-2'), order('BW-3')].join('\n\n');
const orders = parseMessage(three);

test('orderKey: الرقم المرجعي إن وُجد وإلا محتوى الأوردر', () => {
  assert.equal(sel.orderKey({ ref: 'BW-1', items: [], total: 1 }), 'BW-1');
  const a = parseMessage(order('', ''))[0];
  const b = parseMessage(order('', ''))[0];
  const c = parseMessage(order('').replace('100420', '100421'))[0];
  assert.equal(sel.orderKey(a), sel.orderKey(b));
  assert.notEqual(sel.orderKey(a), sel.orderKey(c));
  assert.ok(sel.orderKey(a).startsWith('#'));
});

test('selectedOrders: الافتراضي الكل، والاستبعاد يحافظ على الترتيب', () => {
  assert.deepEqual(sel.selectedOrders(orders, new Set()).map((o) => o.ref), ['BW-1', 'BW-2', 'BW-3']);
  assert.deepEqual(sel.selectedOrders(orders, new Set(['BW-2'])).map((o) => o.ref), ['BW-1', 'BW-3']);
  assert.deepEqual(sel.selectedOrders(orders, sel.excludeAll(orders)), []);
});

test('excludePrinted: يستبعد المطبوع سابقًا فقط ولا يلمس ما بلا رقم', () => {
  const noRef = parseMessage(order(''))[0];
  const all = [...orders, noRef];
  const ex = sel.excludePrinted(all, new Map([['BW-1', 5], ['BW-3', 9], ['BW-X', 1]]));
  assert.deepEqual([...ex].sort(), ['BW-1', 'BW-3']);
  assert.deepEqual(sel.selectedOrders(all, ex).map((o) => o.ref), ['BW-2', '']);
});

test('toggleOrder: يقلب الحالة بدون تعديل الأصل', () => {
  const start = new Set();
  const off = sel.toggleOrder(start, orders[0]);
  assert.deepEqual([...off], ['BW-1']);
  assert.equal(start.size, 0);
  assert.equal(sel.toggleOrder(off, orders[0]).size, 0);
});

test('pruneExcluded: يحذف المفاتيح الغائبة ويرجع نفس الـ Set لو لم يتغير شيء', () => {
  const ex = new Set(['BW-1', 'BW-OLD']);
  const pruned = sel.pruneExcluded(ex, orders);
  assert.deepEqual([...pruned], ['BW-1']);
  assert.equal(sel.pruneExcluded(pruned, orders), pruned);
  const empty = new Set();
  assert.equal(sel.pruneExcluded(empty, orders), empty);
});

test('الاستبعاد يبقى صالحًا بعد تعديل النص أو تغيير الترتيب', () => {
  const ex = new Set(['BW-2']);
  const reordered = parseMessage([order('BW-3'), order('BW-2'), order('BW-1')].join('\n\n'));
  assert.deepEqual(sel.selectedOrders(reordered, ex).map((o) => o.ref), ['BW-3', 'BW-1']);
});
