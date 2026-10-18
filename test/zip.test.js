const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { extractChatText, zipMessage, pickChatEntry } = require('../src/zip');

// يبني ملف zip صغيرًا في الذاكرة: files = [{ name, data: Buffer, method: 0|8, flags? }]
function buildZip(files, { comment = '' } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const body = f.method === 0 ? f.data : zlib.deflateRawSync(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(f.flags || 0, 6);
    local.writeUInt16LE(f.method, 8);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(4, 28); // extra
    parts.push(local, name, Buffer.alloc(4), body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(f.flags || 0, 8);
    cd.writeUInt16LE(f.method, 10);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + 4 + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(Buffer.byteLength(comment), 20);
  return Buffer.concat([...parts, cdBuf, eocd, Buffer.from(comment)]);
}

// reader يسجّل المقاطع المقروءة لنتأكد أننا لا نقرأ الملف كله
function readerOf(buf) {
  const reads = [];
  return {
    size: buf.length,
    reads,
    read: async (start, end) => {
      reads.push([start, end]);
      return new Uint8Array(buf.subarray(start, end));
    },
  };
}

const CHAT = '[18/10/2026, 10:00] Ali: *BESTWAY · ONLINE ORDER*\nمرحبا ✓';

test('zip: ملف _chat.txt مضغوط (deflate) بحروف عربية', async () => {
  const zip = buildZip([{ name: '_chat.txt', data: Buffer.from(CHAT), method: 8 }]);
  const r = await extractChatText(readerOf(zip));
  assert.deepEqual(r, { ok: true, text: CHAT, name: '_chat.txt' });
});

test('zip: ملف غير مضغوط (stored)', async () => {
  const zip = buildZip([{ name: 'WhatsApp Chat with Ali.txt', data: Buffer.from(CHAT), method: 0 }]);
  const r = await extractChatText(readerOf(zip));
  assert.equal(r.ok, true);
  assert.equal(r.text, CHAT);
  assert.equal(r.name, 'WhatsApp Chat with Ali.txt');
});

test('zip: يتجاوز الوسائط ويفضّل _chat.txt، ولا يقرأ الوسائط من الـ reader', async () => {
  const media = Buffer.alloc(200000, 7);
  const zip = buildZip([
    { name: 'IMG-0001.jpg', data: media, method: 0 },
    { name: '__MACOSX/._chat.txt', data: Buffer.from('junk'), method: 0 },
    { name: '_chat.txt', data: Buffer.from(CHAT), method: 8 },
    { name: 'notes.txt', data: Buffer.from('x'.repeat(5000)), method: 0 },
  ]);
  const reader = readerOf(zip);
  const r = await extractChatText(reader);
  assert.equal(r.text, CHAT);
  const bytesRead = reader.reads.reduce((sum, [s, e]) => sum + (e - s), 0);
  assert.ok(bytesRead < zip.length / 2, `قرأ ${bytesRead} من ${zip.length}`);
});

test('zip: بدون _chat.txt نختار أكبر ملف نصي', () => {
  const pick = pickChatEntry([
    { name: 'a.txt', size: 10 },
    { name: 'dir/b.txt', size: 500 },
    { name: 'c.jpg', size: 9999 },
  ]);
  assert.equal(pick.name, 'dir/b.txt');
});

test('zip: تعليق في آخر الملف لا يمنع القراءة', async () => {
  const zip = buildZip([{ name: '_chat.txt', data: Buffer.from(CHAT), method: 8 }], { comment: 'hello comment' });
  assert.equal((await extractChatText(readerOf(zip))).text, CHAT);
});

test('zip: BOM في بداية النص يُحذف', async () => {
  const zip = buildZip([{ name: '_chat.txt', data: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc')]), method: 0 }]);
  assert.equal((await extractChatText(readerOf(zip))).text, 'abc');
});

test('zip: حالات الفشل برسائل مختلفة', async () => {
  const notZip = Buffer.from('this is just a text file, not a zip');
  assert.deepEqual(await extractChatText(readerOf(notZip)), { ok: false, reason: 'not-zip' });

  const noChat = buildZip([{ name: 'IMG.jpg', data: Buffer.from('x'), method: 0 }]);
  assert.deepEqual(await extractChatText(readerOf(noChat)), { ok: false, reason: 'no-chat' });

  const enc = buildZip([{ name: '_chat.txt', data: Buffer.from('x'), method: 0, flags: 1 }]);
  assert.deepEqual(await extractChatText(readerOf(enc)), { ok: false, reason: 'encrypted' });

  const weird = buildZip([{ name: '_chat.txt', data: Buffer.from('x'), method: 0 }]);
  weird.writeUInt16LE(14, weird.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10); // lzma
  assert.deepEqual(await extractChatText(readerOf(weird)), { ok: false, reason: 'unsupported' });

  const truncated = buildZip([{ name: '_chat.txt', data: Buffer.from(CHAT), method: 8 }]);
  truncated.writeUInt32LE(truncated.length + 1000, truncated.length - 6); // cdOffset خارج الملف
  assert.deepEqual(await extractChatText(readerOf(truncated)), { ok: false, reason: 'corrupt' });

  const badData = buildZip([{ name: '_chat.txt', data: Buffer.from(CHAT), method: 8 }]);
  const failing = async () => { throw new Error('bad deflate'); };
  assert.deepEqual(await extractChatText(readerOf(badData), failing), { ok: false, reason: 'corrupt' });
  const noStream = async () => { throw new Error('unsupported'); };
  assert.deepEqual(await extractChatText(readerOf(badData), noStream), { ok: false, reason: 'unsupported' });
});

test('zipMessage: رسالة مختلفة لكل سبب', () => {
  const reasons = ['no-chat', 'encrypted', 'too-big', 'unsupported', 'corrupt'];
  assert.equal(new Set(reasons.map(zipMessage)).size, reasons.length);
});
