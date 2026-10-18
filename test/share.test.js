const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const share = require('../src/share');

// Cache API مبسّط في الذاكرة
function fakeCaches(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async open() {
      return {
        async match(key) {
          return store.has(key) ? new Response(store.get(key)) : undefined;
        },
        async delete(key) {
          return store.delete(key);
        },
      };
    },
  };
}

test('isShareLaunch يتعرف على ?share=1 فقط', () => {
  assert.equal(share.isShareLaunch('?share=1'), true);
  assert.equal(share.isShareLaunch('?a=2&share=1'), true);
  assert.equal(share.isShareLaunch('?share=10'), false);
  assert.equal(share.isShareLaunch(''), false);
  assert.equal(share.isShareLaunch(undefined), false);
});

test('takeSharedText: يقرأ النص مرة واحدة ثم يمسحه', async () => {
  const c = fakeCaches({ [share.SHARE_KEY]: '  *BESTWAY · ONLINE ORDER*  ' });
  assert.equal(await share.takeSharedText(c, '?share=1'), '*BESTWAY · ONLINE ORDER*');
  assert.equal(c.store.size, 0);
  assert.equal(await share.takeSharedText(c, '?share=1'), '');
});

test('takeSharedText: لا يلمس الـ Cache بدون ?share=1', async () => {
  const c = fakeCaches({ [share.SHARE_KEY]: 'x' });
  assert.equal(await share.takeSharedText(c, ''), '');
  assert.equal(c.store.size, 1);
});

test('takeSharedText: بدون Cache API أو عند الخطأ يرجع نصًا فارغًا', async () => {
  assert.equal(await share.takeSharedText(undefined, '?share=1'), '');
  const broken = { open: async () => { throw new Error('boom'); } };
  assert.equal(await share.takeSharedText(broken, '?share=1'), '');
});

test('readClipboardText: نجاح وفراغ ورفض وعدم دعم', async () => {
  assert.deepEqual(await share.readClipboardText({ readText: async () => ' hi ' }), { ok: true, text: 'hi' });
  assert.deepEqual(await share.readClipboardText({ readText: async () => '   ' }), { ok: false, reason: 'empty' });
  assert.deepEqual(await share.readClipboardText({ readText: async () => { throw new Error('denied'); } }), { ok: false, reason: 'denied' });
  assert.deepEqual(await share.readClipboardText(undefined), { ok: false, reason: 'unsupported' });
  assert.deepEqual(await share.readClipboardText({}), { ok: false, reason: 'unsupported' });
});

test('clipboardMessage: رسالة لكل سبب', () => {
  const msgs = ['empty', 'unsupported', 'denied'].map(share.clipboardMessage);
  assert.equal(new Set(msgs).size, 3);
});

test('sw.js يستخدم نفس اسم الـ Cache والمفتاح الموجودَين في src/share.js', () => {
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(sw.includes(`const SHARE='${share.SHARE_CACHE}',KEY='${share.SHARE_KEY}'`));
});

test('manifest: share_target بـ POST على مسار يعترضه sw.js', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.webmanifest'), 'utf8'));
  assert.equal(m.share_target.method, 'POST');
  assert.ok(m.share_target.action.endsWith('/share-target'));
  assert.equal(m.share_target.params.text, 'text');
  const sw = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  assert.ok(sw.includes("endsWith('/share-target')"));
});
