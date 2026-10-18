'use strict';
// قراءة ملف تصدير واتساب المضغوط (.zip) واستخراج نص المحادثة بدون مكتبات.
// نقرأ نهاية الملف (الفهرس) وبايتات ملف المحادثة فقط عبر reader، فلا نحمّل ملفات الوسائط في الذاكرة.
// reader = { size, read(start, end) → Promise<Uint8Array> }

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_TEXT_BYTES = 100 * 1024 * 1024;

const fail = (reason) => ({ ok: false, reason });

// reader لـ File/Blob في المتصفح
function blobReader(blob) {
  return {
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
  };
}

// فك deflate الخام عبر DecompressionStream (Chrome 103+ / Safari 16.4+ / Firefox 113+)
async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('unsupported');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// أي ملف نصي يصلح، ونفضّل _chat.txt (آيفون) ثم أكبر ملف .txt (أندرويد: «WhatsApp Chat with X.txt»)
function pickChatEntry(entries) {
  const texts = entries.filter((e) => /\.txt$/i.test(e.name) && !/(^|\/)(__MACOSX\/|\._)/.test(e.name));
  if (!texts.length) return null;
  return texts.find((e) => /(^|\/)_chat\.txt$/i.test(e.name)) || texts.sort((a, b) => b.size - a.size)[0];
}

async function readEntries(reader) {
  // EOCD في آخر 22 بايت (+ تعليق حتى 65535)
  const tailStart = Math.max(0, reader.size - 65557);
  const tail = await reader.read(tailStart, reader.size);
  const tv = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOffset = tv.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip64');
  if (cdOffset + cdSize > reader.size) throw new Error('corrupt');

  const cd = await reader.read(cdOffset, cdOffset + cdSize);
  const cv = view(cd);
  const decoder = new TextDecoder();
  const entries = [];
  let pos = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > cd.length || cv.getUint32(pos, true) !== CENTRAL_SIG) throw new Error('corrupt');
    const nameLen = cv.getUint16(pos + 28, true);
    const extraLen = cv.getUint16(pos + 30, true);
    const commentLen = cv.getUint16(pos + 32, true);
    entries.push({
      flags: cv.getUint16(pos + 8, true),
      method: cv.getUint16(pos + 10, true),
      compSize: cv.getUint32(pos + 20, true),
      size: cv.getUint32(pos + 24, true),
      localOffset: cv.getUint32(pos + 42, true),
      name: decoder.decode(cd.subarray(pos + 46, pos + 46 + nameLen)),
    });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// يرجع { ok:true, text, name } أو { ok:false, reason }
// reason: not-zip | no-chat | encrypted | too-big | unsupported | corrupt
async function extractChatText(reader, inflate = inflateRaw) {
  try {
    const entries = await readEntries(reader);
    if (!entries) return fail('not-zip');
    const entry = pickChatEntry(entries);
    if (!entry) return fail('no-chat');
    if (entry.flags & 1) return fail('encrypted');
    if (entry.size > MAX_TEXT_BYTES) return fail('too-big');
    if (entry.method !== 0 && entry.method !== 8) return fail('unsupported');

    const header = await reader.read(entry.localOffset, entry.localOffset + 30);
    const hv = view(header);
    if (header.length < 30 || hv.getUint32(0, true) !== LOCAL_SIG) return fail('corrupt');
    const dataStart = entry.localOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
    const data = await reader.read(dataStart, dataStart + entry.compSize);
    if (data.length !== entry.compSize) return fail('corrupt');

    const bytes = entry.method === 0 ? data : await inflate(data);
    return { ok: true, text: new TextDecoder().decode(bytes), name: entry.name.split('/').pop() };
  } catch (error) {
    const msg = String((error && error.message) || error);
    if (msg === 'unsupported' || msg === 'zip64') return fail('unsupported');
    return fail('corrupt');
  }
}

function zipMessage(reason) {
  switch (reason) {
    case 'no-chat':
      return 'الملف المضغوط لا يحتوي ملف محادثة (.txt)';
    case 'encrypted':
      return 'الملف المضغوط محمي بكلمة سر ولا يمكن فتحه';
    case 'too-big':
      return 'ملف المحادثة داخل الـ zip كبير جدًا';
    case 'unsupported':
      return 'المتصفح لا يدعم فك هذا الـ zip — فُكّه وارفع ملف .txt';
    default:
      return 'تعذّر قراءة الملف المضغوط — جرّب تصدير المحادثة مرة أخرى';
  }
}

module.exports = { blobReader, extractChatText, zipMessage, pickChatEntry };
