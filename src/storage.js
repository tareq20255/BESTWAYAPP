'use strict';
// سجل الطلبات المطبوعة وإعدادات قالب الإيصال (localStorage).
// الدوال النقية (addToHistory / cleanTemplate) تُختبر مباشرة في test/.

const HISTORY_KEY = 'wa2p-orders-v1';
const HISTORY_MAX = 50;
const TEMPLATE_KEY = 'wa2p-tpl-v1';
const TEMPLATE_DEFAULTS = {
  brand: '',
  header: '',
  footer: '',
  logo: '',
  logoSrc: '',
  logoMode: 'threshold',
  logoInvert: false,
  logoRatio: 0,
  logoSize: 'm',
  logoReplacesBrand: true,
};
const TEMPLATE_TEXT_FIELDS = ['brand', 'header', 'footer'];
const TEMPLATE_FIELD_MAX = 80;
const LOGO_SIZES = ['s', 'm', 'l'];
// الشعار يُقبل فقط كـ PNG بصيغة data: (من معالجتنا) وبحد أقصى للحجم، فلا تُحمَّل صور من الإنترنت
const LOGO_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/;
const LOGO_MAX_CHARS = 200000;
// النسخة الرمادية المصغّرة (JPEG) التي نعيد منها المعالجة عند تغيير النمط
const LOGO_SRC_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/;
const LOGO_SRC_MAX_CHARS = 300000;

function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // التخزين ممتلئ أو ممنوع: السجل اختياري فنتجاهل
  }
}

// يضيف النص في أول السجل (بدون تكرار) ويقصّ على آخر HISTORY_MAX.
// لو النص موجود من قبل نجمع أرقامه المرجعية (طباعة جزئية ثم إكمال الباقي)
function addToHistory(list, text, orders, now) {
  if (!text || !text.trim() || !orders.length) return list;
  const previous = list.find((item) => item.text === text);
  const refs = orders.map((order) => order.ref).filter(Boolean);
  const entry = {
    id: now,
    at: now,
    text,
    refs: [...new Set([...((previous && previous.refs) || []), ...refs])],
    count: orders.length,
  };
  return [entry, ...list.filter((item) => item.text !== text)].slice(0, HISTORY_MAX);
}

// الأرقام المرجعية (Ref) التي طُبعت من قبل: Map(ref → وقت آخر طباعة)
function printedRefs(list) {
  const printed = new Map();
  for (const entry of list) {
    for (const ref of entry.refs || []) {
      if (!printed.has(ref) || printed.get(ref) < entry.at) printed.set(ref, entry.at);
    }
  }
  return printed;
}

// يفصل نصوص الأوردرات إلى جديدة ومطبوعة سابقًا (كل الـ Ref فيها مطبوع). parseMessage يُمرَّر من القارئ
function splitPrinted(texts, printed, parseMessage) {
  const fresh = [];
  const already = [];
  for (const text of texts) {
    const refs = parseMessage(text).map((order) => order.ref).filter(Boolean);
    (refs.length && refs.every((ref) => printed.has(ref)) ? already : fresh).push(text);
  }
  return { fresh, printed: already };
}

// ينظّف إعدادات القالب: نصوص مقصوصة، شعار صالح فقط، وقيم محدودة. الحقول الغريبة تُهمَل
function cleanTemplate(template) {
  const src = template || {};
  const out = {};
  for (const key of TEMPLATE_TEXT_FIELDS) {
    out[key] = String(src[key] || '')
      .trim()
      .slice(0, TEMPLATE_FIELD_MAX);
  }
  const logoOk = typeof src.logo === 'string' && src.logo.length <= LOGO_MAX_CHARS && LOGO_RE.test(src.logo);
  const ratio = Number(src.logoRatio);
  const srcOk =
    logoOk && typeof src.logoSrc === 'string' && src.logoSrc.length <= LOGO_SRC_MAX_CHARS && LOGO_SRC_RE.test(src.logoSrc);
  out.logo = logoOk ? src.logo : '';
  out.logoSrc = srcOk ? src.logoSrc : '';
  out.logoMode = src.logoMode === 'dither' ? 'dither' : 'threshold';
  out.logoInvert = src.logoInvert === true;
  out.logoRatio = logoOk && ratio >= 0.05 && ratio <= 4 ? ratio : 0;
  out.logoSize = LOGO_SIZES.includes(src.logoSize) ? src.logoSize : 'm';
  out.logoReplacesBrand = src.logoReplacesBrand !== false;
  return out;
}

function loadTemplate() {
  try {
    return { ...TEMPLATE_DEFAULTS, ...JSON.parse(localStorage.getItem(TEMPLATE_KEY) || '{}') };
  } catch {
    return { ...TEMPLATE_DEFAULTS };
  }
}

function saveTemplate(template) {
  try {
    localStorage.setItem(TEMPLATE_KEY, JSON.stringify(template));
  } catch {
    // نفس السبب أعلاه
  }
}

module.exports = {
  HISTORY_MAX,
  TEMPLATE_DEFAULTS,
  loadHistory,
  saveHistory,
  addToHistory,
  printedRefs,
  splitPrinted,
  cleanTemplate,
  loadTemplate,
  saveTemplate,
};
