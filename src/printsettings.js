'use strict';
// إعدادات الطباعة المحفوظة: عرض الورق، وعرض الطابعة بالنقاط لكل ورق.
// عند تغيير الورق يُضبط عدد النقاط تلقائيًا (58 مم ← 384، و75/80 مم ← 576)، وأي تعديل يدوي
// (مثل 640 لورق 80 مم) يُحفظ لذلك الورق فيعود عند اختياره من جديد.

const PAPERS = ['80', '75', '58'];
const DOTS = [576, 640, 384];
const DEFAULT_PAPER = '75';
const DEFAULT_DOTS = { 80: 576, 75: 576, 58: 384 };
const STORAGE_KEY = 'wa2p-print-v1';

// ينظّف الإعدادات المحفوظة: ورق وقيم نقاط معروفة فقط
function cleanSettings(raw) {
  const src = raw || {};
  const paper = PAPERS.includes(String(src.paper)) ? String(src.paper) : DEFAULT_PAPER;
  const dotsByPaper = {};
  for (const p of PAPERS) {
    const value = Number(src.dotsByPaper && src.dotsByPaper[p]);
    if (DOTS.includes(value)) dotsByPaper[p] = value;
  }
  return { paper, dotsByPaper };
}

// عدد النقاط للورق: اختيار المستخدم المحفوظ وإلا الافتراضي التلقائي
function dotsFor(settings, paper) {
  const saved = cleanSettings(settings).dotsByPaper[paper];
  return saved || DEFAULT_DOTS[paper] || 576;
}

const withPaper = (settings, paper) => ({
  ...cleanSettings(settings),
  paper: PAPERS.includes(String(paper)) ? String(paper) : DEFAULT_PAPER,
});

function withDots(settings, paper, dots) {
  const clean = cleanSettings(settings);
  if (!PAPERS.includes(String(paper)) || !DOTS.includes(dots)) return clean;
  return { ...clean, dotsByPaper: { ...clean.dotsByPaper, [paper]: dots } };
}

function loadPrintSettings() {
  try {
    return cleanSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
  } catch {
    return cleanSettings({});
  }
}

function savePrintSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanSettings(settings)));
  } catch {
    // التخزين ممتلئ أو ممنوع: الإعدادات اختيارية فنتجاهل
  }
}

module.exports = {
  PAPERS,
  DOTS,
  DEFAULT_PAPER,
  DEFAULT_DOTS,
  cleanSettings,
  dotsFor,
  withPaper,
  withDots,
  loadPrintSettings,
  savePrintSettings,
};
