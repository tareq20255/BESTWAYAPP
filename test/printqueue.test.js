const test = require('node:test');
const assert = require('node:assert/strict');
const { describeUsbError, createUsbSession, usbSender, runQueue } = require('../src/printqueue');

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

test('usbSender + runQueue: فشل في الإرسال يغلق الجلسة والمحاولة التالية تعيد الاتصال', async () => {
  const { log, usb } = fakeUsb({ failTransferAt: 1 }); // الإرسال الثاني يفشل مرة واحدة
  const session = createUsbSession(usb);
  const done = [];
  const r = await runQueue([new Uint8Array(5), new Uint8Array(6), new Uint8Array(7)], usbSender(session), {
    onItemDone: (i) => done.push(i),
    sleep: noSleep,
  });
  await session.close();
  assert.equal(r.ok, true);
  assert.deepEqual(done, [0, 1, 2]);
  assert.equal(log.filter((l) => l === 'open').length, 2, log.join(','));
});
