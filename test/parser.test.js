const test = require('node:test');
const assert = require('node:assert/strict');
const { isOrder, parseMessage } = require('./load-parser');

const EN = `*BESTWAY · ONLINE ORDER*
Ref: BW-1

Method: Delivery
Name: Ali

*Items:*
• 1× 100420 Garlic Peeled 45 EGP
• 750 g 100392 Bananas ≈ 41.25 EGP

Subtotal: 86.25 EGP
Delivery: 20 EGP
Total: 106.25 EGP
Ordered at 10:00`;

const AR = `*بيست واي · طلب أونلاين*
رقم الطلب: BW-2
الطريقة: توصيل

الطلبات:
• 2× 100420 ثوم مقشر 45 جنيه
• 750 جم 100392 موز ≈ 41.25 جنيه

المجموع: 86.25 جنيه
التوصيل: 20 جنيه
الإجمالي: 106.25 جنيه`;

test('isOrder يتعرف على الصيغتين ويرفض النص العادي', () => {
  assert.equal(isOrder(EN), true);
  assert.equal(isOrder(AR), true);
  assert.equal(isOrder('مرحبا، عايز أسأل عن الأسعار'), false);
});

test('أوردر إنجليزي: الحقول والأصناف والمجاميع', () => {
  const [o] = parseMessage(EN);
  assert.equal(o.ref, 'BW-1');
  assert.equal(o.method, 'Delivery');
  assert.deepEqual(o.fields, [['Name', 'Ali']]);
  assert.equal(o.lang, 'en');
  assert.equal(o.currency, 'EGP');
  assert.equal(o.items.length, 2);
  assert.equal(o.subtotal, 86.25);
  assert.equal(o.delivery, 20);
  assert.equal(o.total, 106.25);
  assert.equal(o.footer, 'Ordered at 10:00');
  assert.deepEqual(o.warnings, []);
});

test('صنف بالعدد: الكود ونوعه والسعر', () => {
  const [o] = parseMessage(EN);
  const { unit, ...item } = o.items[0];
  assert.equal(unit, undefined);
  assert.deepEqual(item, { qty: 1, name: 'Garlic Peeled', kind: 'PLU', code: '100420', total: 45, approx: false });
});

test('صنف موزون: الكمية بالجرام وعلامة التقريب', () => {
  const [o] = parseMessage(EN);
  assert.equal(o.items[1].qty, 750);
  assert.equal(o.items[1].unit, 'g');
  assert.equal(o.items[1].total, 41.25);
  assert.equal(o.items[1].approx, true);
});

test('كود من 13 رقم يُعتبر SKU وغيره PLU', () => {
  const [o] = parseMessage(EN.replace('100420', '6221234567890'));
  assert.equal(o.items[0].kind, 'SKU');
  assert.equal(o.items[1].kind, 'PLU');
});

test('أوردر عربي: اللغة والعملة والمجاميع واسم العلامة', () => {
  const [o] = parseMessage(AR);
  assert.equal(o.lang, 'ar');
  assert.equal(o.brand, 'بست واي');
  assert.equal(o.ref, 'BW-2');
  assert.equal(o.method, 'توصيل');
  assert.equal(o.currency, 'ج.م');
  assert.equal(o.items.length, 2);
  assert.equal(o.items[1].unit, 'جم');
  assert.equal(o.subtotal, 86.25);
  assert.equal(o.delivery, 20);
  assert.equal(o.total, 106.25);
  assert.deepEqual(o.warnings, []);
});

test('تحذير لو مجموع الأصناف لا يطابق Subtotal', () => {
  const [o] = parseMessage(EN.replace('Subtotal: 86.25', 'Subtotal: 90'));
  assert.ok(o.warnings.some(w => w.includes('Subtotal')));
});

test('تحذير لو الإجمالي لا يطابق المجموع + التوصيل', () => {
  const [o] = parseMessage(EN.replace('Total: 106.25', 'Total: 100'));
  assert.ok(o.warnings.some(w => w.includes('الإجمالي')));
});

test('بدون Total: يُحسب من Subtotal + Delivery - Discount', () => {
  const [o] = parseMessage(EN.replace('Total: 106.25 EGP\n', '').replace('Delivery: 20 EGP', 'Delivery: 20 EGP\nDiscount: 5 EGP'));
  assert.equal(o.total, 101.25);
});

test('الأرقام بفواصل الآلاف', () => {
  const [o] = parseMessage(EN.replace('Garlic Peeled 45 EGP', 'Rice 1,250.50 EGP').replace('Subtotal: 86.25', 'Subtotal: 1,291.75'));
  assert.equal(o.items[0].total, 1250.5);
  assert.equal(o.subtotal, 1291.75);
});

test('الصيغة القديمة: كمية × اسم — SKU — سعر', () => {
  const old = `*BESTWAY · ONLINE ORDER*
Ref: BW-3
*Items:*
• 3 × Milk 1L — SKU 6221234567890 — 90 EGP
Subtotal: 90 EGP
Total: 90 EGP`;
  const [o] = parseMessage(old);
  assert.equal(o.items.length, 1);
  assert.equal(o.items[0].qty, 3);
  assert.equal(o.items[0].name, 'Milk 1L');
  assert.equal(o.items[0].kind, 'SKU');
  assert.equal(o.items[0].total, 90);
});

test('سطر غير مفهوم يُتجاهل ولا يكسر باقي الأصناف', () => {
  const [o] = parseMessage(EN.replace('• 750 g', '• ??? × ???'));
  assert.equal(o.items.length, 1);
});

test('عدة أوردرات في رسالة واحدة تُفصل', () => {
  const two = EN + '\n\n' + EN.replace('BW-1', 'BW-9');
  const r = parseMessage(two);
  assert.deepEqual(r.map(o => o.ref), ['BW-1', 'BW-9']);
});

test('الطلب المقسوم: دمج الجزأين في إيصال واحد', () => {
  const p1 = `*BESTWAY · ONLINE ORDER*
PART 1 OF 2
Ref: BW-5
• 1× 100420 Garlic Peeled 45 EGP
… and 1 more item(s)`;
  const p2 = `*BESTWAY · ONLINE ORDER*
PART 2 OF 2
Ref: BW-5
• 1× 100421 Onion 20 EGP
Subtotal: 65 EGP
Total: 65 EGP`;
  const r = parseMessage(p1 + '\n\n' + p2);
  assert.equal(r.length, 1);
  assert.equal(r[0].items.length, 2);
  assert.equal(r[0].total, 65);
  assert.equal(r[0].more, 0);
  assert.equal(r[0].part, '');
});

test('الجزء الأول وحده: تنبيه بالأصناف الناقصة', () => {
  const p1 = `*BESTWAY · ONLINE ORDER*
PART 1 OF 2
Ref: BW-5
• 1× 100420 Garlic Peeled 45 EGP
… and 1 more item(s)`;
  const [o] = parseMessage(p1);
  assert.equal(o.more, 1);
  assert.equal(o.part, 'PART 1 OF 2');
  assert.ok(o.warnings.some(w => w.includes('مقسوم')));
});

test('رسالة بلا أصناف لا تنتج إيصالات', () => {
  assert.deepEqual(parseMessage('*BESTWAY · ONLINE ORDER*\nRef: BW-7'), []);
});
