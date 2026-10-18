'use strict';
// استقبال الأوردر من خارج التطبيق: المشاركة من واتساب (Web Share Target) واللصق من الحافظة.
// المشاركة بـ POST يعترضها sw.js فلا يخرج النص من الجهاز ولا يظهر في رابط (سجلات السيرفر).
// sw.js يحفظ النص مؤقتًا في Cache باسم SHARE_CACHE ومفتاح SHARE_KEY (نفس القيم مكررة هناك،
// وtest/share.test.js يتأكد من تطابقها).

const SHARE_CACHE = 'wa2p-share';
const SHARE_KEY = 'payload';

// بعد التحويل من الـ Service Worker يفتح التطبيق على ?share=1
const isShareLaunch = (search) => /(^|[?&])share=1(&|$)/.test(search || '');

// يقرأ النص المُشارَك مرة واحدة ويمسحه من الـ Cache. يرجع '' لو لا يوجد
async function takeSharedText(cacheStorage, search) {
  if (!isShareLaunch(search) || !cacheStorage) return '';
  try {
    const cache = await cacheStorage.open(SHARE_CACHE);
    const hit = await cache.match(SHARE_KEY);
    if (!hit) return '';
    const text = (await hit.text()).trim();
    await cache.delete(SHARE_KEY);
    return text;
  } catch {
    return '';
  }
}

// يقرأ نص الحافظة. clipboard يُمرَّر من المتصفح (navigator.clipboard)
async function readClipboardText(clipboard) {
  if (!clipboard || typeof clipboard.readText !== 'function') return { ok: false, reason: 'unsupported' };
  try {
    const text = ((await clipboard.readText()) || '').trim();
    return text ? { ok: true, text } : { ok: false, reason: 'empty' };
  } catch {
    return { ok: false, reason: 'denied' };
  }
}

function clipboardMessage(reason) {
  if (reason === 'empty') return 'الحافظة فارغة — انسخ رسالة الأوردر أولاً';
  if (reason === 'unsupported') return 'المتصفح لا يدعم اللصق بالزر — الصق يدويًا في الخانة';
  return 'تعذّر قراءة الحافظة — اسمح بالوصول للحافظة أو الصق يدويًا';
}

module.exports = {
  SHARE_CACHE,
  SHARE_KEY,
  isShareLaunch,
  takeSharedText,
  readClipboardText,
  clipboardMessage,
};
