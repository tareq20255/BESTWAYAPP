const test = require('node:test');
const assert = require('node:assert/strict');
const { describeUsbError, createUsbSession, sessionSender, runQueue } = require('../src/printqueue');

const noSleep = () => Promise.resolve();
const err = (name, message) => Object.assign(new Error(message), { name });

test('describeUsbError: تصنيف الأخطاء الشائعة', () => {
  assert.equal(describeUsbError(new Error('no-webusb')).code, 'no-webusb');
  assert.equal(describeUsbError(new Error('no-printer-iface')).code, 'no-printer');
  assert.equal(describeUsbError(err('NotFoundError', 'No device selected.')).code, 'no-printer');
  assert.equal(describeUsbError(err('NotFoundError', 'The device was disconnected.')).code, 'io');
  assert.equal(describeUsbError(err('NetworkError', 'A transfer error has occurred.')).code, 'io');
  assert.equal(describeUsbError(err('NetworkError', 'Unable to claim interface.')).code, 'busy');
  assert.equal(describeUsbError(err('SecurityError', 'Access denied.')).code, 'busy');
  const unknown = describeUsbError(new Error('x'.repeat(200)));
  assert.equal(unknown.code, 'unknown');
  assert.ok(unknown.message.length < 120);
  assert.equal(describeUsbError(new Error('no-webusb')).retryable, false);
  assert.equal(describeUsbError(err('NotFoundError', 'No device selected.')).retryable, false);
  assert.equal(describeUsbError(err('NetworkError', 'transfer')).retryable, true);
});

test('runQueue: يرسل بالترتيب ويبلّغ بالتقدّم', async () => {
  const sent = [];
  const progress = [];
  const done = [];
  const r = await runQueue(['a', 'b', 'c'], async (item, i) => sent.push([item, i]), {
    onProgress: (i, n) => progress.push([i, n]),
    onItemDone: (i) => done.push(i),
    sleep: noSleep,
  });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(sent, [['a', 0], ['b', 1], ['c', 2]]);
  assert.deepEqual(progress, [[0, 3], [1, 3], [2, 3]]);
  assert.deepEqual(done, [0, 1, 2]);
});

test('runQueue: عطل عابر يُعاد تلقائيًا ثم ينجح', async () => {
  let calls = 0;
  const send = async () => {
    calls++;
    if (calls === 1) throw err('NetworkError', 'transfer failed');
  };
  const r = await runQueue(['a'], send, { sleep: noSleep });
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});

test('runQueue: فشل متكرر يتوقف عند الإيصال المعطّل ويحتفظ بما طُبع', async () => {
  const done = [];
  const send = async (item) => {
    if (item === 'b') throw err('NetworkError', 'transfer failed');
  };
  const r = await runQueue(['a', 'b', 'c'], send, { onItemDone: (i) => done.push(i), sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.failedAt, 1);
  assert.equal(r.code, 'io');
  assert.ok(r.message);
  assert.deepEqual(done, [0]);
});

test('runQueue: خطأ غير قابل للإعادة لا يُعاد', async () => {
  let calls = 0;
  const r = await runQueue(['a'], async () => { calls++; throw err('NotFoundError', 'No device selected.'); }, { sleep: noSleep });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-printer');
  assert.equal(calls, 1);
});

test('runQueue: الإكمال من نقطة محددة (إعادة المحاولة / تخطي)', async () => {
  const sent = [];
  const r = await runQueue(['a', 'b', 'c', 'd'], async (item) => sent.push(item), { from: 2, sleep: noSleep });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, ['c', 'd']);
  assert.deepEqual(await runQueue(['a'], async () => { throw new Error('never'); }, { from: 1, sleep: noSleep }), { ok: true });
});

// طابعة USB وهمية
function fakeUsb({ failTransferAt = -1, claimFails = false } = {}) {
  const log = [];
  let transfers = 0;
  const device = {
    configurations: [{ interfaces: [{ alternates: [{ interfaceClass: 7 }] }] }],
    configuration: { interfaces: [{ interfaceNumber: 1, alternates: [{ interfaceClass: 7, endpoints: [{ direction: 'out', type: 'bulk', endpointNumber: 2 }] }] }] },
    async open() { log.push('open'); },
    async selectConfiguration() { log.push('select'); },
    async claimInterface(n) { if (claimFails) throw err('NetworkError', 'Unable to claim interface.'); log.push('claim' + n); },
    async transferOut(ep, data) {
      if (transfers++ === failTransferAt) throw err('NetworkError', 'transfer failed');
      log.push(`out${ep}:${data.length}`);
    },
    async releaseInterface(n) { log.push('release' + n); },
    async close() { log.push('close'); },
  };
  return { log, usb: { getDevices: async () => [device], requestDevice: async () => device } };
}

test('createUsbSession: يفتح الطابعة مرة واحدة لعدة إيصالات ويقسّم البيانات', async () => {
  const { log, usb } = fakeUsb();
  const session = createUsbSession(usb);
  await session.write(new Uint8Array(20000));
  await session.write(new Uint8Array(10));
  await session.close();
  assert.deepEqual(log, ['open', 'claim1', 'out2:16384', 'out2:3616', 'out2:10', 'release1', 'close']);
});

test('createUsbSession: بعد close يعيد الفتح عند الكتابة التالية', async () => {
  const { log, usb } = fakeUsb();
  const session = createUsbSession(usb);
  await session.write(new Uint8Array(1));
  await session.close();
  await session.write(new Uint8Array(1));
  assert.equal(log.filter((l) => l === 'open').length, 2);
  await session.close();
  await session.close(); // آمن
});

test('createUsbSession: فشل الحجز يغلق الجهاز ويرمي الخطأ', async () => {
  const { log, usb } = fakeUsb({ claimFails: true });
  const session = createUsbSession(usb);
  await assert.rejects(() => session.write(new Uint8Array(1)), /claim/);
  assert.ok(log.includes('close'));
});

test('sessionSender + runQueue: فشل في الإرسال يغلق الجلسة والمحاولة التالية تعيد الاتصال', async () => {
  const { log, usb } = fakeUsb({ failTransferAt: 1 }); // الإرسال الثاني يفشل مرة واحدة
  const session = createUsbSession(usb);
  const done = [];
  const r = await runQueue([new Uint8Array(5), new Uint8Array(6), new Uint8Array(7)], sessionSender(session), {
    onItemDone: (i) => done.push(i),
    sleep: noSleep,
  });
  await session.close();
  assert.equal(r.ok, true);
  assert.deepEqual(done, [0, 1, 2]);
  assert.equal(log.filter((l) => l === 'open').length, 2, log.join(','));
});

// ---------- البلوتوث (BLE) ----------
const { describeBleError, describePrintError, createBleSession, BLE_SERVICES } = require('../src/printqueue');

// بلوتوث وهمي: services = [{ uuid, chars: [{ props, maxPart?, failWith? }] }]
function fakeBluetooth({ services, maxPart = Infinity, failWrite } = {}) {
  const log = { requests: [], connects: 0, disconnects: 0, written: [] };
  const mkChar = (def) => ({
    properties: def.props,
    async writeValueWithoutResponse(part) { return this._w('nr', part); },
    async writeValueWithResponse(part) { return this._w('wr', part); },
    async _w(kind, part) {
      if (failWrite) throw failWrite();
      if (part.length > maxPart) throw err('NetworkError', 'GATT operation failed: value too long');
      log.written.push([kind, ...part]);
    },
  });
  const gatt = {
    connected: false,
    async connect() {
      log.connects++;
      gatt.connected = true;
      return {
        getPrimaryServices: async () =>
          services.map((s) => ({ uuid: s.uuid, getCharacteristics: async () => s.chars.map(mkChar) })),
      };
    },
    disconnect() { log.disconnects++; gatt.connected = false; },
  };
  const device = { gatt };
  return { log, bluetooth: { requestDevice: async (opts) => { log.requests.push(opts); return device; } } };
}
const UNKNOWN = '12345678-0000-1000-8000-00805f9b34fb';
const readOnly = { props: { read: true } };
const nrChar = { props: { writeWithoutResponse: true } };
const wrChar = { props: { write: true } };
const flatten = (written) => written.flatMap(([, ...bytes]) => bytes);

test('describeBleError: تصنيف أخطاء البلوتوث', () => {
  assert.equal(describeBleError(new Error('no-webbluetooth')).code, 'no-ble');
  assert.equal(describeBleError(new Error('no-ble-characteristic')).code, 'ble-unsupported-printer');
  assert.equal(describeBleError(err('NotFoundError', 'User cancelled the requestDevice() chooser.')).code, 'no-printer');
  assert.equal(describeBleError(err('NetworkError', 'GATT Server is disconnected.')).code, 'io');
  assert.equal(describeBleError(err('SecurityError', 'Origin is not allowed')).code, 'denied');
  assert.equal(describeBleError(new Error('x'.repeat(200))).message.length < 120, true);
  assert.equal(describeBleError(new Error('no-webbluetooth')).retryable, false);
  assert.equal(describeBleError(err('NetworkError', 'GATT operation failed')).retryable, true);
  assert.equal(describePrintError(err('NotFoundError', 'x'), 'ble').message, 'لم تُختر طابعة بلوتوث');
  assert.equal(describePrintError(err('NotFoundError', 'x'), 'usb').message, 'مفيش طابعة USB متعرّف عليها');
});

test('createBleSession: يطلب الطابعة مرة واحدة بالخدمات المعروفة ويختار قناة الكتابة', async () => {
  const { log, bluetooth } = fakeBluetooth({
    services: [
      { uuid: UNKNOWN, chars: [nrChar] },
      { uuid: BLE_SERVICES[1], chars: [readOnly, nrChar] },
    ],
  });
  const session = createBleSession(bluetooth, { device: null }, { delayMs: 0 });
  await session.write(Uint8Array.from([1, 2, 3]));
  await session.write(Uint8Array.from([4]));
  assert.equal(log.requests.length, 1);
  assert.equal(log.requests[0].acceptAllDevices, true);
  assert.deepEqual(log.requests[0].optionalServices, BLE_SERVICES);
  assert.equal(log.connects, 1);
  assert.deepEqual(log.written, [['nr', 1, 2, 3], ['nr', 4]]);
});

test('createBleSession: يفضّل الكتابة بدون استجابة وإلا يستخدم الكتابة العادية', async () => {
  const both = fakeBluetooth({ services: [{ uuid: BLE_SERVICES[0], chars: [{ props: { write: true, writeWithoutResponse: true } }] }] });
  const s1 = createBleSession(both.bluetooth, { device: null }, { delayMs: 0 });
  await s1.write(Uint8Array.from([9]));
  assert.equal(both.log.written[0][0], 'nr');

  const only = fakeBluetooth({ services: [{ uuid: BLE_SERVICES[0], chars: [wrChar] }] });
  const s2 = createBleSession(only.bluetooth, { device: null }, { delayMs: 0 });
  await s2.write(Uint8Array.from([9]));
  assert.equal(only.log.written[0][0], 'wr');
});

test('createBleSession: يقسّم البيانات إلى أجزاء 128 بايت بالترتيب مع تأخير بينها', async () => {
  const { log, bluetooth } = fakeBluetooth({ services: [{ uuid: BLE_SERVICES[0], chars: [nrChar] }] });
  let sleeps = 0;
  const session = createBleSession(bluetooth, { device: null }, { delayMs: 5, sleep: async () => { sleeps++; } });
  const data = Uint8Array.from({ length: 300 }, (_, i) => i % 256);
  await session.write(data);
  assert.deepEqual(log.written.map((w) => w.length - 1), [128, 128, 44]);
  assert.deepEqual(flatten(log.written), [...data]);
  assert.equal(sleeps, 3);
});

test('createBleSession: MTU صغير → يصغّر الجزء تلقائيًا ويُكمل بدون فقد بيانات', async () => {
  const { log, bluetooth } = fakeBluetooth({ services: [{ uuid: BLE_SERVICES[0], chars: [nrChar] }], maxPart: 40 });
  const session = createBleSession(bluetooth, { device: null }, { delayMs: 0 });
  const data = Uint8Array.from({ length: 200 }, (_, i) => (i * 7) % 256);
  await session.write(data);
  assert.deepEqual(flatten(log.written), [...data]);
  assert.ok(log.written.every((w) => w.length - 1 <= 40));
});

test('createBleSession: الحد الأدنى للجزء 20 بايت ثم يفشل بخطأ واضح', async () => {
  const { bluetooth } = fakeBluetooth({ services: [{ uuid: BLE_SERVICES[0], chars: [nrChar] }], maxPart: 5 });
  const session = createBleSession(bluetooth, { device: null }, { delayMs: 0 });
  await assert.rejects(() => session.write(new Uint8Array(100)), /too long/);
});

test('createBleSession: انقطاع الاتصال لا يصغّر الجزء ويُرمى الخطأ', async () => {
  const { log, bluetooth } = fakeBluetooth({
    services: [{ uuid: BLE_SERVICES[0], chars: [nrChar] }],
    failWrite: () => err('NetworkError', 'GATT Server is disconnected.'),
  });
  const session = createBleSession(bluetooth, { device: null }, { delayMs: 0 });
  await assert.rejects(() => session.write(new Uint8Array(500)), /disconnected/);
  assert.equal(log.written.length, 0);
});

test('createBleSession: الطابعة المختارة تُحفظ في cache فلا نافذة اختيار جديدة، وclose يفصل فقط', async () => {
  const { log, bluetooth } = fakeBluetooth({ services: [{ uuid: BLE_SERVICES[0], chars: [nrChar] }] });
  const cache = { device: null };
  const a = createBleSession(bluetooth, cache, { delayMs: 0 });
  await a.write(Uint8Array.from([1]));
  await a.close();
  assert.equal(log.disconnects, 1);
  assert.ok(cache.device);
  const b = createBleSession(bluetooth, cache, { delayMs: 0 });
  await b.write(Uint8Array.from([2]));
  assert.equal(log.requests.length, 1);
  assert.equal(log.connects, 2);
  await b.close();
  await b.close(); // آمن
});

test('createBleSession: بلا قناة كتابة → no-ble-characteristic ويفصل الاتصال', async () => {
  const { log, bluetooth } = fakeBluetooth({ services: [{ uuid: UNKNOWN, chars: [readOnly] }] });
  const session = createBleSession(bluetooth, { device: null }, { delayMs: 0 });
  await assert.rejects(() => session.write(new Uint8Array(1)), /no-ble-characteristic/);
  assert.equal(log.disconnects, 1);
});

test('createBleSession: بدون Web Bluetooth → no-webbluetooth', async () => {
  const session = createBleSession(undefined, { device: null }, { delayMs: 0 });
  await assert.rejects(() => session.write(new Uint8Array(1)), /no-webbluetooth/);
});

test('runQueue مع BLE: أخطاء غير قابلة للإعادة تتوقف برسالة البلوتوث، والعابرة تعيد الاتصال', async () => {
  const cancel = await runQueue(['a'], async () => { throw err('NotFoundError', 'User cancelled the requestDevice() chooser.'); }, {
    describe: (e) => describePrintError(e, 'ble'),
    sleep: noSleep,
  });
  assert.equal(cancel.ok, false);
  assert.equal(cancel.message, 'لم تُختر طابعة بلوتوث');

  // فشل عابر في الإيصال الثاني: المحاولة التالية تعيد الاتصال بنفس الطابعة بدون اختيار جديد
  let failOnce = true;
  const { log, bluetooth } = fakeBluetooth({ services: [{ uuid: BLE_SERVICES[0], chars: [nrChar] }] });
  const session = createBleSession(bluetooth, { device: null }, { delayMs: 0 });
  const realWrite = session.write;
  session.write = async (bytes) => {
    if (bytes[0] === 2 && failOnce) {
      failOnce = false;
      throw err('NetworkError', 'GATT Server is disconnected.');
    }
    return realWrite(bytes);
  };
  const r = await runQueue([Uint8Array.from([1]), Uint8Array.from([2]), Uint8Array.from([3])], sessionSender(session), {
    describe: (e) => describePrintError(e, 'ble'),
    sleep: noSleep,
  });
  await session.close();
  assert.equal(r.ok, true);
  assert.deepEqual(flatten(log.written), [1, 2, 3]);
  assert.equal(log.requests.length, 1);
  assert.equal(log.connects, 2);
});
