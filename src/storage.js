'use strict';
// سجل الطلبات المطبوعة وإعدادات قالب الإيصال (localStorage).
// الدوال النقية (addToHistory / cleanTemplate) تُختبر مباشرة في test/.

const HISTORY_KEY = 'wa2p-orders-v1';
const HISTORY_MAX = 50;
const TEMPLATE_KEY = 'wa2p-tpl-v1';
const TEMPLATE_DEFAULTS = { brand: '', header: '', footer: '' };
const TEMPLATE_FIELD_MAX = 80;

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

// يضيف النص في أول السجل (بدون تكرار) ويقصّ على آخر HISTORY_MAX
function addToHistory(list, text, orders, now) {
  if (!text || !text.trim() || !orders.length) return list;
  const entry = {
    id: now,
    at: now,
    text,
    refs: orders.map((order) => order.ref).filter(Boolean),
    count: orders.length,
  };
  return [entry, ...list.filter((item) => item.text !== text)].slice(0, HISTORY_MAX);
}

// يُبقي الحقول المعروفة فقط، نصوصًا مقصوصة وبحد أقصى للطول
function cleanTemplate(template) {
  const out = {};
  for (const key of Object.keys(TEMPLATE_DEFAULTS)) {
    out[key] = String((template && template[key]) || '')
      .trim()
      .slice(0, TEMPLATE_FIELD_MAX);
  }
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
  cleanTemplate,
  loadTemplate,
  saveTemplate,
};
