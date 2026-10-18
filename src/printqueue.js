'use strict';
// الطباعة المباشرة عبر USB (WebUSB + ESC/POS) بالدفعة: نفتح الطابعة مرة واحدة لكل دفعة،
// ونرسل الإيصالات بالترتيب مع إعادة محاولة تلقائية للأعطال العابرة، ولو فشل إيصال نتوقف عنده
// ويمكن الإكمال منه (إعادة المحاولة / تخطي) بدون إعادة تجهيز الصور.

const CHUNK = 16384;
const PRINTER_CLASS = 7;

// يصنّف خطأ WebUSB: { code, message, retryable }
function describeUsbError(error) {
  const name = (error && error.name) || '';
  const text = String((error && error.message) || error || '');
  if (/no-webusb/.test(text)) {
    return { code: 'no-webusb', message: 'الطباعة المباشرة تحتاج Chrome ورابط https (مش ملف محلي)', retryable: false };
  }
  if (/disconnect|lost/i.test(text)) {
    return { code: 'io', message: 'انقطع الاتصال بالطابعة — تأكد أنها تعمل وفيها ورق', retryable: true };
  }
  if (/no-printer/i.test(text) || /no device selected/i.test(text) || name === 'NotFoundError') {
    return { code: 'no-printer', message: 'مفيش طابعة USB متعرّف عليها', retryable: false };
  }
  if (/claim|busy|access denied/i.test(text) || name === 'SecurityError') {
    return { code: 'busy', message: 'الطابعة مشغولة بتطبيق تاني', retryable: true };
  }
  if (name === 'NetworkError' || /transfer/i.test(text)) {
    return { code: 'io', message: 'تعذّر الإرسال للطابعة — تأكد أنها تعمل وفيها ورق', retryable: true };
  }
  return { code: 'unknown', message: 'تعذّر الاتصال بالطابعة: ' + text.slice(0, 60), retryable: true };
}

const hasPrinterInterface = (device) =>
  (device.configurations || []).some((cfg) =>
    cfg.interfaces.some((iface) => iface.alternates.some((alt) => alt.interfaceClass === PRINTER_CLASS))
  );

// أول طابعة سبق السماح بها، وإلا نافذة اختيار المتصفح (تحتاج ضغطة مستخدم)
async function findPrinter(usb) {
  const known = (await usb.getDevices()).find(hasPrinterInterface);
  return known || usb.requestDevice({ filters: [{ classCode: PRINTER_CLASS }] });
}

function printerEndpoint(device) {
  for (const iface of device.configuration.interfaces) {
    for (const alt of iface.alternates) {
      const out = alt.endpoints.find((ep) => ep.direction === 'out' && ep.type === 'bulk');
      if (alt.interfaceClass === PRINTER_CLASS && out) {
        return { iface: iface.interfaceNumber, endpoint: out.endpointNumber };
      }
    }
  }
  throw new Error('no-printer-iface');
}

// اتصال واحد يُعاد استخدامه بين الإيصالات. close() آمن ويمكن الكتابة بعده (يعيد الفتح)
function createUsbSession(usb) {
  let device = null;
  let iface = -1;
  let endpoint = -1;

  async function close() {
    const current = device;
    device = null;
    if (!current) return;
    try { await current.releaseInterface(iface); } catch { /* الجهاز فُصل أو لم يُحجز */ }
    try { await current.close(); } catch { /* نفس السبب */ }
  }

  async function open() {
    const found = await findPrinter(usb);
    try {
      await found.open();
      if (!found.configuration) await found.selectConfiguration(1);
      ({ iface, endpoint } = printerEndpoint(found));
      await found.claimInterface(iface);
    } catch (error) {
      device = found;
      await close();
      throw error;
    }
    device = found;
  }

  async function write(bytes) {
    if (!device) await open();
    for (let i = 0; i < bytes.length; i += CHUNK) {
      await device.transferOut(endpoint, bytes.slice(i, i + CHUNK));
    }
  }

  return { write, close };
}

// دالة إرسال للطابور: عند أي فشل تُغلق الجلسة ليبدأ المحاولة التالية باتصال جديد
function usbSender(session) {
  return async (bytes) => {
    try {
      await session.write(bytes);
    } catch (error) {
      await session.close();
      throw error;
    }
  };
}

// يرسل items بالترتيب بدءًا من from. يرجع { ok:true } أو { ok:false, failedAt, error, code, message }
async function runQueue(items, send, options = {}) {
  const {
    from = 0,
    attempts = 2,
    delayMs = 800,
    onProgress,
    onItemDone,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  for (let i = from; i < items.length; i++) {
    if (onProgress) onProgress(i, items.length);
    let failure = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await send(items[i], i);
        failure = null;
        break;
      } catch (error) {
        failure = { error, ...describeUsbError(error) };
        if (!failure.retryable || attempt === attempts) break;
        await sleep(delayMs);
      }
    }
    if (failure) return { ok: false, failedAt: i, ...failure };
    if (onItemDone) onItemDone(i);
  }
  return { ok: true };
}

module.exports = { describeUsbError, createUsbSession, usbSender, runQueue };
