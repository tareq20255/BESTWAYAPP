const test = require('node:test');
const assert = require('node:assert/strict');
const { isOrder, parseMessage } = require('../src/parser');
const storage = require('../src/storage');

const history = {
  add: storage.addToHistory,
  max: storage.HISTORY_MAX,
  tplClean: storage.cleanTemplate,
  tplDefaults: storage.TEMPLATE_DEFAULTS,
};

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

test('سطر صنف غير مفهوم يظهر كتحذير ولا يكسر باقي الأصناف', () => {
  const [o] = parseMessage(EN.replace('• 750 g 100392 Bananas ≈ 41.25 EGP', '• Bananas بدون سعر'));
  assert.equal(o.items.length, 1);
  assert.ok(o.warnings.includes('تعذر قراءة السطر: • Bananas بدون سعر'));
});

test('سطر غير مفهوم لا يبدأ بنقطة (مثل ملاحظة) لا يولّد تحذيرًا', () => {
  const [o] = parseMessage(EN.replace('Ordered at', 'شكرا لكم\nOrdered at'));
  assert.deepEqual(o.warnings, []);
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

test('السجل: إضافة أوردر في الأول مع الأرقام المرجعية', () => {
  const list = history.add([], EN, parseMessage(EN), 1000);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], { id: 1000, at: 1000, text: EN, refs: ['BW-1'], count: 1 });
});

test('السجل: نفس النص لا يتكرر ويصعد للأول بوقت جديد', () => {
  const a = history.add([], EN, parseMessage(EN), 1);
  const b = history.add(a, AR, parseMessage(AR), 2);
  const c = history.add(b, EN, parseMessage(EN), 3);
  assert.deepEqual(c.map(h => h.refs[0]), ['BW-1', 'BW-2']);
  assert.equal(c[0].at, 3);
});

test('السجل: نص فارغ أو بلا أوردرات لا يُحفظ', () => {
  assert.deepEqual(history.add([], '   ', [], 1), []);
  assert.deepEqual(history.add([], EN, [], 1), []);
});

test('السجل: الحد الأقصى 50 والأحدث أولاً', () => {
  let list = [];
  for (let i = 0; i < 60; i++) {
    const t = EN.replace('BW-1', 'BW-' + i);
    list = history.add(list, t, parseMessage(t), i);
  }
  assert.equal(list.length, history.max);
  assert.equal(list[0].refs[0], 'BW-59');
});

test('القالب: تنظيف المسافات وقص الطول وتجاهل الحقول الغريبة', () => {
  const c = history.tplClean({ brand: '  بست واي  ', header: 'x'.repeat(200), footer: null, evil: '<b>' });
  assert.deepEqual(Object.keys(c), Object.keys(history.tplDefaults));
  assert.equal(c.brand, 'بست واي');
  assert.equal(c.header.length, 80);
  assert.equal(c.footer, '');
  assert.equal(c.evil, undefined);
});

test('القالب: قيم افتراضية عند غياب الإعدادات', () => {
  assert.deepEqual(history.tplClean(undefined), history.tplDefaults);
  assert.deepEqual(history.tplClean({}), history.tplDefaults);
});

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('القالب: الشعار يُقبل كـ PNG data فقط ويُرفض غيره', () => {
  const ok = history.tplClean({ logo: PNG, logoRatio: 0.5 });
  assert.equal(ok.logo, PNG);
  assert.equal(ok.logoRatio, 0.5);
  for (const bad of ['https://evil.example/x.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,@@@', 'javascript:alert(1)', 5, null]) {
    const c = history.tplClean({ logo: bad, logoRatio: 0.5 });
    assert.equal(c.logo, '', String(bad));
    assert.equal(c.logoRatio, 0);
  }
  assert.equal(history.tplClean({ logo: PNG + 'A'.repeat(200000) }).logo, '');
});

test('القالب: نسبة الشعار وحجمه وخيار الاستبدال ضمن قيم مسموحة', () => {
  assert.equal(history.tplClean({ logo: PNG, logoRatio: 99 }).logoRatio, 0);
  assert.equal(history.tplClean({ logo: PNG, logoRatio: 0.001 }).logoRatio, 0);
  assert.equal(history.tplClean({ logoSize: 'xl' }).logoSize, 'm');
  assert.equal(history.tplClean({ logoSize: 'l' }).logoSize, 'l');
  assert.equal(history.tplClean({}).logoReplacesBrand, true);
  assert.equal(history.tplClean({ logoReplacesBrand: false }).logoReplacesBrand, false);
});

test('السجل: printedRefs يجمع الأرقام ويحتفظ بآخر وقت طباعة', () => {
  const list = [
    { id: 3, at: 300, text: 'c', refs: ['BW-1'], count: 1 },
    { id: 2, at: 200, text: 'b', refs: ['BW-2', 'BW-1'], count: 2 },
    { id: 1, at: 100, text: 'a', refs: undefined, count: 1 },
  ];
  const printed = storage.printedRefs(list);
  assert.equal(printed.get('BW-1'), 300);
  assert.equal(printed.get('BW-2'), 200);
  assert.equal(printed.size, 2);
});

test('السحب: splitPrinted يفصل المطبوع سابقًا عن الجديد', () => {
  const t1 = EN;
  const t2 = EN.replace('BW-1', 'BW-9');
  const noRef = '*BESTWAY · ONLINE ORDER*\n• 1× 100420 Garlic Peeled 45 EGP';
  const printed = new Map([['BW-1', 5]]);
  const r = storage.splitPrinted([t1, t2, noRef], printed, parseMessage);
  assert.deepEqual(r.printed, [t1]);
  assert.deepEqual(r.fresh, [t2, noRef]);
});

test('السحب: لا شيء مطبوع → الكل جديد', () => {
  const r = storage.splitPrinted([EN], new Map(), parseMessage);
  assert.deepEqual(r, { fresh: [EN], printed: [] });
});

test('السجل: نفس النص بأرقام جديدة يدمج الأرقام (طباعة جزئية ثم إكمال)', () => {
  const two = EN + '\n\n' + EN.replace('BW-1', 'BW-2');
  const orders = parseMessage(two);
  const first = history.add([], two, [orders[0]], 1);
  assert.deepEqual(first[0].refs, ['BW-1']);
  const second = history.add(first, two, [orders[1]], 2);
  assert.equal(second.length, 1);
  assert.deepEqual(second[0].refs, ['BW-1', 'BW-2']);
  assert.equal(second[0].at, 2);
});

const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

test('القالب: النسخة الرمادية JPEG فقط ومع وجود شعار، ونمط وعكس ضمن قيم مسموحة', () => {
  const ok = history.tplClean({ logo: PNG, logoSrc: JPG, logoMode: 'dither', logoInvert: true });
  assert.equal(ok.logoSrc, JPG);
  assert.equal(ok.logoMode, 'dither');
  assert.equal(ok.logoInvert, true);
  // بدون شعار لا نسخة
  assert.equal(history.tplClean({ logoSrc: JPG }).logoSrc, '');
  for (const bad of [PNG, 'https://evil.example/x.jpg', 'data:image/jpeg;base64,@@', 5, null]) {
    assert.equal(history.tplClean({ logo: PNG, logoSrc: bad }).logoSrc, '', String(bad));
  }
  assert.equal(history.tplClean({ logo: PNG, logoSrc: JPG + 'A'.repeat(300000) }).logoSrc, '');
  assert.equal(history.tplClean({ logoMode: 'sepia' }).logoMode, 'threshold');
  assert.equal(history.tplClean({ logoInvert: 'yes' }).logoInvert, false);
  assert.equal(history.tplClean({}).logoMode, 'threshold');
});
