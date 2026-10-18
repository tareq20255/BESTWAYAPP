'use strict';
// قارئ رسائل الأوردر (عربي / إنجليزي). يُحقن في index.html عبر `node build.js`
// ويُختبر مباشرة في test/. لا يعتمد على المتصفح أو DOM.

// رقم بفواصل آلاف وكسور اختيارية
const NUM = '\\d[\\d,]*(?:\\.\\d+)?';
// وحدات الوزن والحجم وعملات الأسعار
const UNITS = 'kg|g|ml|l|كجم|جم|جرام|كيلو';
const CURRENCIES = 'EGP|USD|SAR|AED|ج\\.?م|جنيه';
const ARABIC = /[؀-ۿ]/;

// سطر العنوان: «BESTWAY · ONLINE ORDER» أو «بيست واي · طلب أونلاين»
const HEADER_RE =
  /^\s*\*?\s*(?<brand>[^*·|•—]+?)\s*[·|]\s*(?<title>[^*•—]*(?:ORDER|طلب)[^*•—]*?)\s*\*?\s*$/i;

// الصيغة الجديدة: «1× 100420 اسم 45 EGP» أو الموزون «750 g 100392 اسم ≈ 41.25 EGP»
const ITEM_NEW_RE = RegExp(
  `^(?:(?<qty>${NUM})\\s*[\xd7xX]|(?<wq>${NUM})\\s*(?<unit>${UNITS}))\\s*(?<code>\\d{4,14})\\s+(?<name>.+?)\\s+(?<approx>≈)?\\s*(?<price>${NUM})\\s*(?<cur>${CURRENCIES})$`,
  'iu'
);

// صيغة «اسم — كود — [كمية] سعر» بأشكالها
const ITEM_DASH_RE = RegExp(
  `^(?:(?<lq>${NUM})\\s*[\xd7xX]\\s*)?(?<name>.+?)\\s+[—–-]\\s+(?:(?<kind>كود الميزان|باركود|كود|SKU|PLU|EAN|BARCODE|CODE)\\s*[:#]?\\s*(?<code>[A-Za-z0-9-]+)\\s+[—–-]\\s+)?(?:(?<q>${NUM})\\s*(?<unit>${UNITS})\\s+|(?<q2>${NUM})\\s*[\xd7xX]\\s+)?(?<approx>≈)?\\s*(?<price>${NUM})\\s*(?<cur>${CURRENCIES})$`,
  'iu'
);

const KIND_BY_ARABIC_LABEL = { 'كود الميزان': 'PLU', باركود: 'EAN', كود: 'SKU' };

// الصيغة القديمة: «2 × اسم — SKU 123 — 50 EGP»
const QTY_PREFIX_RE = RegExp(
  `^\\s*(?:[•\xb7\\-]\\s*)?(?<qty>${NUM})\\s*[\xd7xX]\\s*(?<rest>.+?)\\s*$`
);
const LEGACY_WITH_CODE_RE = RegExp(
  `^(?<name>.+?)\\s+[—–-]\\s+(?<kind>SKU|PLU|EAN|BARCODE|CODE)\\s*[:#]?\\s*(?<code>[A-Za-z0-9-]+)\\s+[—–-]\\s+(?<price>${NUM})\\s*(?<cur>[A-Za-z]{2,4}|ج\\.?م|جنيه)?$`,
  'i'
);
const LEGACY_NO_CODE_RE = RegExp(
  `^(?<name>.+?)\\s+[—–-]\\s+(?<price>${NUM})\\s*(?<cur>[A-Za-z]{2,4}|ج\\.?م|جنيه)?$`,
  'i'
);

// سطور المجاميع: «Subtotal: 86.25 EGP» / «الإجمالي: ≈ 106 جنيه»
const TOTAL_RE = RegExp(
  `^(?<label>Subtotal|Delivery|Discount|Total|المجموع|التوصيل|الخصم|الإجمالي|الاجمالي)\\s*(?:\\((?<note>[^)]*)\\))?\\s*:\\s*(?<approx>≈)?\\s*(?<amt>${NUM})\\s*(?<cur>\\S+)?`,
  'i'
);

// حقل عام «Name: Ali»
const FIELD_RE =
  /^(?<k>[A-Za-z؀-ۿ][A-Za-z؀-ۿ ]{0,20}?)\s*:\s*(?<v>.+)$/;

const toNumber = (text) => parseFloat(text.replace(/,/g, ''));
// يشيل علامات الخط العريض وعلامات الاتجاه غير المرئية
const clean = (text) => text.replace(/\*/g, '').replace(/[‎‏]/g, '').trim();
const isHeader = (line) => HEADER_RE.test(line) && /ORDER|طلب/i.test(line);
const currencyOf = (cur) => (cur ? (ARABIC.test(cur) ? 'ج.م' : cur.toUpperCase()) : '');
// كود من 13 رقم = باركود SKU، غير كده كود ميزان PLU
const kindOfCode = (code) => (/^\d{13}$/.test(code) ? 'SKU' : 'PLU');

// هل النص يبدو أوردرًا؟
function isOrder(text) {
  return (
    !!(/\bONLINE ORDER\b/i.test(text) || /طلب\s+أونلاين|طلب\s+اونلاين/.test(text)) ||
    /(^|\n)\s*[•·-]?\s*\d+\s*[×xX]\s*.+[—–-]\s*(SKU|PLU|EAN|BARCODE)\b/i.test(text)
  );
}

// يحلّل أوردرًا واحدًا (نص يبدأ بسطر العنوان) إلى كائن الإيصال
function parseOrder(text) {
  const order = {
    brand: 'ORDER',
    title: '',
    ref: '',
    method: '',
    fields: [],
    items: [],
    subtotal: null,
    delivery: null,
    discount: null,
    total: null,
    totalNote: '',
    currency: 'EGP',
    footer: '',
    warnings: [],
    lang: ARABIC.test(text.split(/\r?\n/).find((line) => isHeader(line)) || '') ? 'ar' : 'en',
    part: '',
    more: 0,
    approxTotal: false,
    note: '',
  };

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;

    const header = rawLine.match(HEADER_RE);
    if (header?.groups && isHeader(rawLine) && !order.items.length && !order.ref) {
      order.brand = clean(header.groups.brand).replace(/بيست\s*واي/g, 'بست واي').toUpperCase();
      order.title = clean(header.groups.title).toUpperCase();
      continue;
    }

    const line = clean(rawLine);

    // «PART 1 OF 2» / «الجزء 1 من 2»
    const part =
      line.match(/^PART\s+(\d+)\s+OF\s+(\d+)$/i) || line.match(/^الجزء\s+(\d+)\s+من\s+(\d+)$/);
    if (part) {
      order.part = `PART ${part[1]} OF ${part[2]}`;
      continue;
    }

    // «… and 3 more item(s)» / «و 3 صنف»
    const more =
      line.match(/(\d+)\s+more\s+items?/i) || line.match(/و\s*(\d+)\s+(?:صنف|منتج|بند)/);
    if (more && /^[….]|^and\b|^و/i.test(line)) {
      order.more = parseInt(more[1], 10);
      continue;
    }

    if (/تقديري|estimat/i.test(line) && !/^[•·-]/.test(line)) {
      order.note = line;
      continue;
    }

    const body = line.replace(/^[•·\-]\s*/, '');
    const qtyPrefix = QTY_PREFIX_RE.exec(line);
    const isLegacyItem =
      qtyPrefix?.groups &&
      (LEGACY_WITH_CODE_RE.test(qtyPrefix.groups.rest) || LEGACY_NO_CODE_RE.test(qtyPrefix.groups.rest));

    if (!isLegacyItem) {
      const item = body.match(ITEM_NEW_RE);
      if (item?.groups) {
        const g = item.groups;
        const weighed = !!g.wq;
        order.items.push({
          qty: toNumber(g.qty || g.wq),
          name: g.name.trim(),
          kind: kindOfCode(g.code),
          code: g.code,
          total: toNumber(g.price),
          unit: weighed ? g.unit.toLowerCase() : undefined,
          approx: !!g.approx || weighed,
        });
        order.currency = currencyOf(g.cur) || order.currency;
        continue;
      }

      if (/^[•·-]/.test(line) || / [—–-] /.test(line)) {
        const dashed = body.match(ITEM_DASH_RE);
        if (dashed?.groups && !/^(Subtotal|Delivery|Discount|Total)\b/i.test(body)) {
          const g = dashed.groups;
          const qty = g.q || g.q2 || g.lq;
          const weighed = !!g.q;
          order.items.push({
            qty: qty ? toNumber(qty) : 1,
            name: g.name.trim(),
            kind: g.kind ? KIND_BY_ARABIC_LABEL[g.kind] || g.kind.toUpperCase() : '',
            code: g.code || '',
            total: toNumber(g.price),
            unit: weighed ? g.unit : undefined,
            approx: !!g.approx || weighed,
          });
          order.currency = currencyOf(g.cur) || order.currency;
          continue;
        }
      }
    }

    if (qtyPrefix?.groups) {
      const qty = toNumber(qtyPrefix.groups.qty);
      const rest = qtyPrefix.groups.rest;

      const withCode = rest.match(LEGACY_WITH_CODE_RE);
      if (withCode?.groups) {
        order.items.push({
          qty,
          name: withCode.groups.name.trim(),
          kind: withCode.groups.kind.toUpperCase(),
          code: withCode.groups.code,
          total: toNumber(withCode.groups.price),
        });
        if (withCode.groups.cur) order.currency = withCode.groups.cur.toUpperCase();
        continue;
      }

      const noCode = rest.match(LEGACY_NO_CODE_RE);
      if (noCode?.groups) {
        order.items.push({ qty, name: noCode.groups.name.trim(), kind: '', code: '', total: toNumber(noCode.groups.price) });
        continue;
      }

      order.warnings.push(`تعذر قراءة السطر: ${line}`);
      continue;
    }

    const totalLine = line.match(TOTAL_RE);
    if (totalLine?.groups) {
      const g = totalLine.groups;
      const label = g.label.toLowerCase();
      const amount = toNumber(g.amt);
      if (g.cur && /^[A-Za-z]{2,4}$/.test(g.cur)) order.currency = g.cur.toUpperCase();
      else if (g.cur && /ج/.test(g.cur)) order.currency = 'ج.م';

      if (label === 'subtotal' || label === 'المجموع') order.subtotal = amount;
      else if (label === 'delivery' || label === 'التوصيل') order.delivery = amount;
      else if (label === 'discount' || label === 'الخصم') order.discount = amount;
      else {
        order.total = amount;
        order.approxTotal = !!g.approx;
        order.totalNote = (g.note || '').trim();
      }
      continue;
    }

    if (/^ordered at/i.test(line) || /^تم الطلب/.test(line)) {
      order.footer = line;
      continue;
    }
    if (/^items\s*:?$/i.test(line) || /^الطلبات\s*:?$/.test(line)) continue;

    const field = line.match(FIELD_RE);
    if (field?.groups) {
      const key = field.groups.k.trim();
      const value = field.groups.v.trim();
      if (key.toLowerCase() === 'ref' || key === 'رقم الطلب') order.ref = value;
      else if (key.toLowerCase() === 'method' || key === 'الطريقة') order.method = value;
      else order.fields.push([key, value]);
    } else if (/^[•·]/.test(line)) {
      // سطر صنف لم نفهمه: ننبّه بدل ما يختفي بصمت
      order.warnings.push(`تعذر قراءة السطر: ${line}`);
    }
  }

  if (order.more) {
    order.warnings.push(`الطلب مقسوم: ${order.more} صنف إضافي في الرسالة التالية`);
  }

  const itemsSum = order.items.reduce((sum, item) => sum + item.total, 0);
  if (order.subtotal !== null && Math.abs(itemsSum - order.subtotal) > 0.01) {
    order.warnings.push(`مجموع الأصناف ${itemsSum} لا يساوي Subtotal ${order.subtotal}`);
  }
  if (order.total !== null && order.subtotal !== null) {
    const expected = order.subtotal + (order.delivery || 0) - (order.discount || 0);
    if (Math.abs(expected - order.total) > 0.01) {
      order.warnings.push(`الإجمالي ${order.total} لا يساوي ${expected}`);
    }
  }
  if (order.total === null && order.subtotal !== null) {
    order.total = order.subtotal + (order.delivery || 0) - (order.discount || 0);
  }
  return order;
}

// يقسم رسالة فيها أوردر أو أكثر، ويدمج أجزاء الطلب المقسوم (نفس الـ Ref) في إيصال واحد
function parseMessage(text) {
  const lines = text.split(/\r?\n/);
  const headerIdx = [];
  lines.forEach((line, idx) => {
    if (isHeader(line)) headerIdx.push(idx);
  });

  let chunks;
  if (!headerIdx.length) {
    chunks = [text];
  } else {
    headerIdx.push(lines.length);
    chunks = headerIdx.slice(0, -1).map((start, n) => lines.slice(start, headerIdx[n + 1]).join('\n'));
  }

  return chunks
    .filter((chunk) => chunk.trim())
    .map(parseOrder)
    .filter((order) => order.items.length > 0)
    .reduce((orders, order) => {
      const prev = orders[orders.length - 1];
      if (prev && order.ref && prev.ref === order.ref && (prev.part || prev.more || order.part)) {
        prev.items.push(...order.items);
        prev.more = order.more;
        prev.part = order.part && order.more ? order.part : '';
        for (const key of ['subtotal', 'delivery', 'discount', 'total']) {
          if (order[key] !== null) prev[key] = order[key];
        }
        prev.totalNote = order.totalNote || prev.totalNote;
        prev.approxTotal = prev.approxTotal || order.approxTotal;
        prev.footer = order.footer || prev.footer;
        prev.note = order.note || prev.note;
        prev.warnings = [...prev.warnings.filter((w) => !w.startsWith('الطلب مقسوم')), ...order.warnings];
        return orders;
      }
      orders.push(order);
      return orders;
    }, []);
}

module.exports = { isOrder, parseOrder, parseMessage, isHeader };
