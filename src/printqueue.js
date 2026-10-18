'use strict';
// الطباعة المباشرة بالدفعة عبر USB (WebUSB) أو البلوتوث (Web Bluetooth BLE) بأوامر ESC/POS:
// نفتح الطابعة مرة واحدة لكل دفعة، ونرسل الإيصالات بالترتيب مع إعادة محاولة تلقائية للأعطال العابرة،
// ولو فشل إيصال نتوقف عنده ويمكن الإكمال منه (إعادة المحاولة / تخطي) بدون إعادة تجهيز الصور.
// كل «جلسة» (USB أو BLE) لها نفس الواجهة: { write(bytes), close() }.

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

// خدمات BLE الشائعة في الطابعات الحرارية. Web Bluetooth لا يسمح بالوصول لخدمة غير مذكورة هنا،
// فلو طابعتك تستخدم خدمة أخرى أضف معرّفها هنا (يظهر في nRF Connect).
const BLE_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000af30-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];
const BLE_CHUNK = 128;
const BLE_MIN_CHUNK = 20;
const BLE_DELAY_MS = 10;

// تصنيف أخطاء البلوتوث (نفس شكل describeUsbError)
function describeBleError(error) {
  const name = (error && error.name) || '';
  const text = String((error && error.message) || error || '');
  if (/no-webbluetooth/.test(text)) {
    return {
      code: 'no-ble',
      message: 'الطباعة بالبلوتوث تحتاج Chrome (أندرويد أو ويندوز أو ماك) ورابط https — لا تعمل على iPhone',
      retryable: false,
    };
  }
  if (/no-ble-characteristic/.test(text)) {
    return {
      code: 'ble-unsupported-printer',
      message: 'لم نجد قناة طباعة في هذه الطابعة — قد لا تدعم BLE (بعض الطابعات تعمل بالبلوتوث الكلاسيكي فقط)',
      retryable: false,
    };
  }
  if (/disconnect|gatt|network/i.test(text) || name === 'NetworkError') {
    return { code: 'io', message: 'انقطع اتصال البلوتوث — قرّب الطابعة وتأكد أنها تعمل', retryable: true };
  }
  if (name === 'NotFoundError' || /cancel|no device selected/i.test(text)) {
    return { code: 'no-printer', message: 'لم تُختر طابعة بلوتوث', retryable: false };
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return { code: 'denied', message: 'المتصفح منع الوصول للبلوتوث — اسمح به وجرّب مرة أخرى', retryable: false };
  }
  return { code: 'unknown', message: 'تعذّر الاتصال بالطابعة: ' + text.slice(0, 60), retryable: true };
}

// transport: 'usb' | 'ble'
function describePrintError(error, transport = 'usb') {
  return transport === 'ble' ? describeBleError(error) : describeUsbError(error);
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

// اتصال BLE واحد يُعاد استخدامه بين الإيصالات. cache يحتفظ بالطابعة المختارة (بدون نافذة اختيار جديدة)
// حتى بعد close() أو تحميل دفعة أخرى، إلى أن تُحمَّل الصفحة من جديد.
const bleCache = { device: null };

async function findWritableCharacteristic(server) {
  const services = await server.getPrimaryServices();
  const rank = (service) => {
    const i = BLE_SERVICES.indexOf(service.uuid);
    return i < 0 ? BLE_SERVICES.length : i;
  };
  for (const service of [...services].sort((a, b) => rank(a) - rank(b))) {
    const characteristics = await service.getCharacteristics();
    const writable = characteristics.find((c) => c.properties.writeWithoutResponse || c.properties.write);
    if (writable) return writable;
  }
  throw new Error('no-ble-characteristic');
}

function createBleSession(bluetooth, cache = bleCache, options = {}) {
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delayMs = options.delayMs === undefined ? BLE_DELAY_MS : options.delayMs;
  let characteristic = null;
  let chunk = BLE_CHUNK;

  async function close() {
    characteristic = null;
    try {
      if (cache.device && cache.device.gatt && cache.device.gatt.connected) cache.device.gatt.disconnect();
    } catch {
      /* الجهاز فُصل أصلًا */
    }
  }

  async function open() {
    if (!bluetooth) throw new Error('no-webbluetooth');
    if (!cache.device) {
      cache.device = await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    }
    try {
      const server = await cache.device.gatt.connect();
      characteristic = await findWritableCharacteristic(server);
    } catch (error) {
      await close();
      throw error;
    }
  }

  const sendPart = (part) =>
    characteristic.properties.writeWithoutResponse
      ? characteristic.writeValueWithoutResponse(part)
      : characteristic.writeValueWithResponse(part);

  async function write(bytes) {
    if (!characteristic) await open();
    for (let i = 0; i < bytes.length; ) {
      const part = bytes.slice(i, i + chunk);
      try {
        await sendPart(part);
      } catch (error) {
        // الاتصال المحدود (MTU صغير) يرفض الأجزاء الكبيرة: نصغّر ونعيد الجزء نفسه
        const lost = /disconnect/i.test(String((error && error.message) || error));
        if (!lost && chunk > BLE_MIN_CHUNK) {
          chunk = Math.max(BLE_MIN_CHUNK, chunk >> 1);
          continue;
        }
        throw error;
      }
      i += part.length;
      if (delayMs) await sleep(delayMs);
    }
  }

  return { write, close };
}

// دالة إرسال للطابور (لأي جلسة USB/BLE): عند أي فشل تُغلق الجلسة ليبدأ المحاولة التالية باتصال جديد
function sessionSender(session) {
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
    describe = describeUsbError,
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
        failure = { error, ...describe(error) };
        if (!failure.retryable || attempt === attempts) break;
        await sleep(delayMs);
      }
    }
    if (failure) return { ok: false, failedAt: i, ...failure };
    if (onItemDone) onItemDone(i);
  }
  return { ok: true };
}

module.exports = {
  BLE_SERVICES,
  describeUsbError,
  describeBleError,
  describePrintError,
  createUsbSession,
  createBleSession,
  sessionSender,
  runQueue,
};
