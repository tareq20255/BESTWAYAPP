const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient, SESSION_KEY } = require('../src/signage-api');

const URL_BASE = 'https://proj.supabase.co';
const KEY = 'sb_publishable_test';

// خادم وهمي: كل طلب يُسجَّل، والرد من دالة handler(req) ← [status, body]
function setup(handler, { session, now = 1_000_000 } = {}) {
  const calls = [];
  const map = new Map();
  const store = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  if (session) map.set(SESSION_KEY, JSON.stringify(session));
  const clock = { now };
  const fetch = async (url, init) => {
    const req = { url, path: url.replace(URL_BASE, ''), method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(req);
    const out = handler(req);
    if (out instanceof Error) throw out;
    const [status, body] = out;
    return { ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) };
  };
  const client = createClient({ url: `${URL_BASE}/`, key: KEY, bucket: 'signage', fetch, store, now: () => clock.now });
  return { client, calls, map, clock };
}
const live = (extra) => Object.assign({ access_token: 'AT', refresh_token: 'RT', expires_at: 1_000_000 / 1000 + 3600 }, extra);
const tokens = (n) => ({ access_token: `AT${n}`, refresh_token: `RT${n}`, expires_in: 3600 });

test('signIn: المفتاح في apikey فقط، والجلسة تُحفظ ثم تُستخدم كتوكن', async () => {
  const { client, calls, map } = setup((req) => (req.path.startsWith('/auth/') ? [200, tokens(1)] : [200, [{ user_id: 'u' }]]));
  assert.equal(client.hasSession(), false);
  await client.signIn('  me@example.com ', 'pw');
  assert.equal(calls[0].path, '/auth/v1/token?grant_type=password');
  assert.deepEqual(calls[0].body, { email: 'me@example.com', password: 'pw' });
  assert.equal(calls[0].headers.apikey, KEY);
  assert.equal(calls[0].headers.Authorization, undefined, 'المفتاح publishable لا يُرسل في Authorization');
  assert.equal(client.hasSession(), true);
  assert.equal(JSON.parse(map.get(SESSION_KEY)).refresh_token, 'RT1');

  assert.equal(await client.isAdmin(), true);
  assert.equal(calls[1].path, '/rest/v1/sg_admins?select=user_id&limit=1');
  assert.equal(calls[1].headers.apikey, KEY);
  assert.equal(calls[1].headers.Authorization, 'Bearer AT1');
});

test('isAdmin: حساب ليس في sg_admins', async () => {
  const { client } = setup(() => [200, []], { session: live() });
  assert.equal(await client.isAdmin(), false);
});

test('بدون جلسة: خطأ دخول بلا أي طلب', async () => {
  const { client, calls } = setup(() => [200, []]);
  await assert.rejects(client.loadLive(), (e) => e.kind === 'auth');
  assert.equal(calls.length, 0);
});

test('التوكن القريب من الانتهاء يتجدد مرة واحدة حتى مع طلبات متزامنة', async () => {
  const { client, calls } = setup(
    (req) => (req.path.startsWith('/auth/') ? [200, tokens(2)] : [200, []]),
    { session: live({ expires_at: 1_000_000 / 1000 + 30 }) },
  );
  await client.loadLive(); // طلبان متزامنان (الشاشات والأكواد)
  const refreshes = calls.filter((c) => c.path === '/auth/v1/token?grant_type=refresh_token');
  assert.equal(refreshes.length, 1);
  assert.deepEqual(refreshes[0].body, { refresh_token: 'RT' });
  const rest = calls.filter((c) => c.path.startsWith('/rest/'));
  assert.equal(rest.length, 2);
  assert.ok(rest.every((c) => c.headers.Authorization === 'Bearer AT2'));
});

test('401 أثناء الطلب: تجديد وإعادة مرة واحدة', async () => {
  let first = true;
  const { client, calls } = setup((req) => {
    if (req.path.startsWith('/auth/')) return [200, tokens(3)];
    if (first) { first = false; return [401, { code: 'PGRST301', message: 'JWT expired' }]; }
    return [200, [{ user_id: 'u' }]];
  }, { session: live() });
  assert.equal(await client.isAdmin(), true);
  assert.deepEqual(calls.map((c) => c.headers.Authorization), ['Bearer AT', undefined, 'Bearer AT3']);
});

test('رفض التجديد ينهي الجلسة، وانقطاع الشبكة يبقيها', async () => {
  const dead = setup((req) => (req.path.startsWith('/auth/') ? [400, { error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }] : [200, []]),
    { session: live({ expires_at: 1 }) });
  await assert.rejects(dead.client.isAdmin(), (e) => e.kind === 'auth');
  assert.equal(dead.client.hasSession(), false);
  assert.equal(dead.map.has(SESSION_KEY), false);

  const flaky = setup((req) => (req.path.startsWith('/auth/') ? new TypeError('fetch failed') : [200, []]), { session: live({ expires_at: 1 }) });
  await assert.rejects(flaky.client.isAdmin(), (e) => e.kind === 'network');
  assert.equal(flaky.client.hasSession(), true);
});

test('أشكال الخطأ الثلاثة: PostgREST و Auth و Storage', async () => {
  const pg = setup(() => [409, { code: '23505', message: 'duplicate key value', details: null, hint: null }], { session: live() });
  await assert.rejects(pg.client.addNamed('branches', 'x'), (e) => e.code === '23505' && e.status === 409 && e.kind === null);
  const auth = setup(() => [400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }]);
  await assert.rejects(auth.client.signIn('a@b.c', 'bad'), (e) => e.code === 'invalid_credentials' && e.message === 'Invalid login credentials');
  assert.equal(auth.client.hasSession(), false);
  const storage = setup(() => [400, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' }], { session: live() });
  await assert.rejects(storage.client.removeFiles(['c/a.jpg']), (e) => e.code === 'Payload too large' && /maximum allowed size/.test(e.message));
  const down = setup(() => new TypeError('fetch failed'), { session: live() });
  await assert.rejects(down.client.loadLive(), (e) => e.kind === 'network');
});

test('loadState: تحويل الصفوف لشكل الواجهة', async () => {
  const { client, calls } = setup((req) => {
    const table = /\/rest\/v1\/(\w+)/.exec(req.path)[1];
    return [200, {
      sg_settings: [{ key: 'tz', value: 'Africa/Cairo' }],
      sg_branches: [{ id: 1, name: 'المعادي' }],
      sg_locations: [{ id: 2, name: 'كاشير' }],
      sg_screens: [{ id: 3, device_id: 'dev', name: 'كاشير 1', branch_id: 1, location_id: 2, orientation: 'auto', view_w: 1080, view_h: 1920, last_seen: '2026-11-11T10:00:00+00:00' }, { id: 4, device_id: 'dev2', name: 'جديدة', branch_id: null, location_id: null, orientation: 'portrait', view_w: null, view_h: null, last_seen: null }],
      sg_pending: [{ code: '123456', created_at: '2026-11-11T09:00:00+00:00' }],
      sg_content: [{
        id: 5, title: 'عرض', type: 'text', file: null, parts: null, text_body: 'أهلًا', url: null, bg: '#111111', fg: '#ffffff', fit: 'contain', duration: 8, sort: 1, enabled: true,
        updated_at: '2026-11-11T08:00:00+00:00',
        sg_rules: [{ id: 9, branch_id: 1, location_id: null, screen_id: null, orientation: 'portrait', days: [5], start_time: '22:00:00', end_time: '02:00:00', start_date: null, end_date: null }],
      }, {
        id: 6, title: 'مجموعة', type: 'group', file: null, parts: [{ file: 'c/a.mp4', kind: 'video' }, { file: 'c/b.jpg', kind: 'image' }], text_body: null, url: null,
        bg: '#111111', fg: '#ffffff', fit: 'cover', duration: 10, sort: 2, enabled: true, updated_at: '2026-11-11T08:00:00+00:00', sg_rules: [],
      }],
    }[table]];
  }, { session: live() });
  const s = await client.loadState();
  assert.equal(calls.length, 6);
  assert.ok(calls.every((c) => c.method === 'GET' && c.headers.Authorization === 'Bearer AT'));
  assert.equal(s.tz, 'Africa/Cairo');
  assert.deepEqual(s.screens[0], { id: 3, device_id: 'dev', name: 'كاشير 1', branch_id: 1, location_id: 2, orientation: 'auto', view_w: 1080, view_h: 1920, last_seen: Date.UTC(2026, 10, 11, 10) });
  assert.equal(s.screens[1].last_seen, null);
  assert.equal(s.screens[1].orientation, 'portrait');
  assert.deepEqual(s.pending.map((p) => p.code), ['123456']);
  assert.deepEqual(s.content[0], {
    id: 5, title: 'عرض', type: 'text', file: null, parts: null, text: 'أهلًا', url: '', bg: '#111111', fg: '#ffffff', fit: 'contain', duration: 8, sort: 1, enabled: true,
    updated: Date.UTC(2026, 10, 11, 8),
    rules: [{ id: 9, branch_id: 1, location_id: null, screen_id: null, orientation: 'portrait', days: [5], start_time: '22:00', end_time: '02:00', start_date: null, end_date: null }],
  });
  assert.deepEqual(s.content[1].parts, [{ file: 'c/a.mp4', kind: 'video' }, { file: 'c/b.jpg', kind: 'image' }]);
  assert.match(calls.find((c) => c.path.includes('sg_screens')).path, /orientation,view_w,view_h/);
  const contentCall = calls.find((c) => c.path.includes('sg_content'));
  assert.match(contentCall.path, /sg_rules\(/);
  assert.match(contentCall.path, /order=sort\.asc,id\.asc/);
});

test('الشاشات والفروع: الطلبات المرسلة للقاعدة', async () => {
  const { client, calls } = setup((req) => (req.path.includes('sg_create_screen') ? [200, 'abcdef0123456789abcdef0123456789'] : [204]), { session: live() });
  await client.pairScreen(' 123456 ', { name: 'كاشير 1', branch_id: 1, location_id: null });
  assert.equal(calls[0].path, '/rest/v1/rpc/sg_pair_screen');
  assert.deepEqual(calls[0].body, { p_code: '123456', p_name: 'كاشير 1', p_branch_id: 1, p_location_id: null });
  assert.equal(await client.createScreen({ name: 'صالة', branch_id: null, location_id: 2 }), 'abcdef0123456789abcdef0123456789');
  await client.updateScreen(7, { name: 'ن', branch_id: 1, location_id: 2, orientation: 'portrait' });
  assert.deepEqual([calls[2].method, calls[2].path, calls[2].headers.Prefer], ['PATCH', '/rest/v1/sg_screens?id=eq.7', 'return=minimal']);
  assert.deepEqual(calls[2].body, { name: 'ن', branch_id: 1, location_id: 2, orientation: 'portrait' });
  await client.deleteScreen(7);
  assert.deepEqual([calls[3].method, calls[3].path], ['DELETE', '/rest/v1/sg_screens?id=eq.7']);
  await client.addNamed('locations', 'صالة');
  assert.deepEqual([calls[4].method, calls[4].path, calls[4].body], ['POST', '/rest/v1/sg_locations', { name: 'صالة' }]);
  await client.renameNamed('branches', 3, 'زايد');
  assert.deepEqual([calls[5].method, calls[5].path], ['PATCH', '/rest/v1/sg_branches?id=eq.3']);
  await client.deleteNamed('branches', '3 or 1=1');
  assert.equal(calls[6].path, '/rest/v1/sg_branches?id=eq.NaN', 'المعرّف يُحوَّل لرقم دائمًا');
  await client.clearPending();
  assert.deepEqual([calls[7].method, calls[7].path], ['DELETE', '/rest/v1/sg_pending?code=not.is.null']);
});

test('createContent: الصف ثم القواعد، ولو فشلت القواعد يُحذف الصف', async () => {
  const ok = setup((req) => (req.method === 'POST' && req.path.startsWith('/rest/v1/sg_content') ? [201, [{ id: 42 }]] : [204]), { session: live() });
  const rules = [{ branch_id: 1, days: [] }];
  assert.equal(await ok.client.createContent({ title: 'ع', type: 'text' }, rules), 42);
  assert.deepEqual(ok.calls.map((c) => `${c.method} ${c.path}`), ['POST /rest/v1/sg_content?select=id', 'POST /rest/v1/rpc/sg_replace_rules']);
  assert.equal(ok.calls[0].headers.Prefer, 'return=representation');
  assert.deepEqual(ok.calls[1].body, { p_content_id: 42, p_rules: rules });

  const bad = setup((req) => {
    if (req.path.startsWith('/rest/v1/sg_content?select')) return [201, [{ id: 43 }]];
    if (req.path.includes('sg_replace_rules')) return [400, { code: '23503', message: 'fk' }];
    return [204];
  }, { session: live() });
  await assert.rejects(bad.client.createContent({ title: 'ع', type: 'text' }, rules), (e) => e.code === '23503');
  assert.deepEqual(bad.calls.at(-1).method + ' ' + bad.calls.at(-1).path, 'DELETE /rest/v1/sg_content?id=eq.43');
});

test('updateContent و setContentEnabled و deleteContent', async () => {
  const { client, calls } = setup(() => [204], { session: live() });
  await client.updateContent(5, { title: 'ج' }, []);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['PATCH /rest/v1/sg_content?id=eq.5', 'POST /rest/v1/rpc/sg_replace_rules']);
  await client.setContentEnabled(5, 0);
  assert.deepEqual(calls[2].body, { enabled: false });
  await client.deleteContent(5, 'c/20261111-abc.jpg');
  assert.deepEqual([calls[3].method, calls[3].path], ['DELETE', '/rest/v1/sg_content?id=eq.5']);
  assert.deepEqual([calls[4].method, calls[4].path, calls[4].body], ['DELETE', '/storage/v1/object/signage', { prefixes: ['c/20261111-abc.jpg'] }]);
  await client.deleteContent(6, null);
  assert.equal(calls.length, 6, 'محتوى بلا ملف: لا طلب للمخزن');
  await client.deleteContent(7, ['c/a.mp4', 'c/b.mp4', 'c/c.jpg']);
  assert.deepEqual(calls[7].body, { prefixes: ['c/a.mp4', 'c/b.mp4', 'c/c.jpg'] }, 'مجموعة: كل ملفاتها تُحذف في طلب واحد');
});

test('deleteContent: فشل حذف الملف لا يُفشل حذف المحتوى', async () => {
  const { client } = setup((req) => (req.path.startsWith('/storage/') ? [500, { message: 'boom' }] : [204]), { session: live() });
  await client.deleteContent(5, 'c/a.jpg');
});

test('publicUrl و signOut', async () => {
  const { client, calls, map } = setup(() => [204], { session: live() });
  assert.equal(client.publicUrl('c/20261111-abc.jpg'), 'https://proj.supabase.co/storage/v1/object/public/signage/c/20261111-abc.jpg');
  assert.equal(client.publicUrl('c/a b.jpg'), 'https://proj.supabase.co/storage/v1/object/public/signage/c/a%20b.jpg');
  assert.equal(client.publicUrl(null), null);
  await client.signOut();
  assert.equal(calls[0].path, '/auth/v1/logout?scope=local');
  assert.equal(calls[0].headers.Authorization, 'Bearer AT');
  assert.equal(client.hasSession(), false);
  assert.equal(map.has(SESSION_KEY), false);
});

test('upload: نموذج متعدد الأجزاء بتوكن المستخدم ومدة تخزين طويلة، مع نسبة التقدّم', async () => {
  const sent = [];
  class FakeXhr {
    constructor() { this.headers = {}; this.upload = {}; sent.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(k, v) { this.headers[k] = v; }
    send(body) {
      this.body = body;
      if (this.upload.onprogress) this.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 });
      this.status = this.fail ? 400 : 200;
      this.responseText = this.fail ? JSON.stringify({ statusCode: '415', error: 'invalid_mime_type', message: 'mime type image/heic is not supported' }) : '{"Key":"signage/c/a.jpg"}';
      this.onload();
    }
  }
  const map = new Map([[SESSION_KEY, JSON.stringify(live())]]);
  const store = { getItem: (k) => map.get(k) || null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  const client = createClient({ url: URL_BASE, key: KEY, bucket: 'signage', fetch: async () => { throw new Error('no fetch'); }, store, now: () => 1_000_000, XMLHttpRequest: FakeXhr });
  const progress = [];
  const blob = new Blob(['x'], { type: 'image/jpeg' });
  assert.equal(await client.upload('c/a.jpg', blob, (p) => progress.push(p)), 'c/a.jpg');
  const x = sent[0];
  assert.deepEqual([x.method, x.url], ['POST', 'https://proj.supabase.co/storage/v1/object/signage/c/a.jpg']);
  assert.deepEqual(x.headers, { apikey: KEY, Authorization: 'Bearer AT', 'x-upsert': 'false' });
  assert.equal(x.body.get('cacheControl'), '31536000');
  assert.equal(x.body.get('').type, 'image/jpeg');
  assert.deepEqual(progress, [0.5]);

  FakeXhr.prototype.fail = true;
  await assert.rejects(client.upload('c/b.heic', blob), (e) => e.status === 400 && /mime type/.test(e.message));
});
