'use strict';
// عميل صغير لـ Supabase بدون مكتبات: تسجيل الدخول (Auth) والجداول (PostgREST) والملفات (Storage).
// يُستخدم في صفحة الإدارة screens.html. صفحة المشغّل player.html لا تحتاجه (طلب واحد بسيط).
// المفتاح publishable يُرسل في ترويسة apikey فقط؛ ترويسة Authorization تحمل توكن المستخدم بعد الدخول.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignageApi = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SESSION_KEY = 'bw-signage:session';
  const TABLES = { branches: 'sg_branches', locations: 'sg_locations' };
  const CONTENT_SELECT = 'id,title,type,file,text_body,url,bg,fg,fit,duration,sort,enabled,updated_at,'
    + 'sg_rules(id,branch_id,location_id,screen_id,days,start_time,end_time,start_date,end_date)';

  class ApiError extends Error {
    constructor(message, info) {
      super(message);
      this.name = 'ApiError';
      this.status = info.status || 0;
      this.code = info.code || null;
      this.kind = info.kind || null; // 'network' | 'auth' | null
    }
  }
  // أشكال الخطأ الثلاثة: PostgREST {code,message} و Auth {error_code,msg} و Storage {statusCode,error,message}
  function toError(status, data) {
    const d = data && typeof data === 'object' ? data : {};
    const message = d.message || d.msg || d.error_description || (typeof d.error === 'string' ? d.error : '') || `HTTP ${status}`;
    const code = d.error_code || (typeof d.code === 'string' ? d.code : null) || (typeof d.error === 'string' ? d.error : null);
    return new ApiError(message, { status, code });
  }
  const hhmm = (t) => (t ? String(t).slice(0, 5) : null);
  const toMs = (iso) => (iso ? Date.parse(iso) : null);

  function memoryStore() {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
  }
  function browserStore() {
    try {
      localStorage.getItem(SESSION_KEY);
      return localStorage;
    } catch (e) {
      return memoryStore();
    }
  }

  function createClient(options) {
    const base = options.url.replace(/\/+$/, '');
    const key = options.key;
    const bucket = options.bucket || 'signage';
    const doFetch = options.fetch || ((url, init) => fetch(url, init));
    const store = options.store || browserStore();
    const clock = options.now || Date.now;
    const Xhr = options.XMLHttpRequest || (typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : null);
    let session = readSession();
    let refreshing = null;

    function readSession() {
      try {
        const s = JSON.parse(store.getItem(SESSION_KEY) || 'null');
        return s && s.access_token && s.refresh_token ? s : null;
      } catch (e) {
        return null;
      }
    }
    function saveSession(data) {
      session = data ? {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at || Math.floor(clock() / 1000) + (data.expires_in || 3600),
      } : null;
      try {
        if (session) store.setItem(SESSION_KEY, JSON.stringify(session));
        else store.removeItem(SESSION_KEY);
      } catch (e) { /* التخزين غير متاح: تبقى الجلسة في الذاكرة */ }
    }
    const authError = () => new ApiError('سجّل الدخول من جديد', { status: 401, kind: 'auth' });

    async function http(method, path, opts = {}) {
      const headers = Object.assign({ apikey: key }, opts.headers);
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      const init = { method, headers };
      if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
      let res;
      try {
        res = await doFetch(base + path, init);
      } catch (e) {
        throw new ApiError('network', { kind: 'network' });
      }
      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (e) { data = null; }
      }
      if (!res.ok) throw toError(res.status, data);
      return data;
    }

    // ---------- الجلسة ----------
    async function refresh() {
      try {
        saveSession(await http('POST', '/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } }));
      } catch (e) {
        // انقطاع مؤقت: نُبقي الجلسة. رفض من السيرفر: الجلسة انتهت
        if (e.kind === 'network' || e.status >= 500) throw e;
        saveSession(null);
        throw authError();
      }
    }
    function refreshOnce() {
      if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
      return refreshing;
    }
    async function token() {
      if (!session) throw authError();
      if (session.expires_at * 1000 - clock() < 60000) await refreshOnce();
      return session.access_token;
    }
    // طلب باسم المستخدم. لو انتهى التوكن أثناء الطلب نجدّده ونعيد مرة واحدة
    async function authed(method, path, opts = {}) {
      try {
        return await http(method, path, Object.assign({}, opts, { token: await token() }));
      } catch (e) {
        if (e.status !== 401 || e.kind === 'auth') throw e;
        await refreshOnce();
        try {
          return await http(method, path, Object.assign({}, opts, { token: session.access_token }));
        } catch (again) {
          if (again.status !== 401) throw again;
          saveSession(null);
          throw authError();
        }
      }
    }
    const minimal = { Prefer: 'return=minimal' };
    const rest = (method, query, opts) => authed(method, `/rest/v1/${query}`, opts);
    const rpc = (fn, args) => authed('POST', `/rest/v1/rpc/${fn}`, { body: args });
    const byId = (table, id) => `${table}?id=eq.${Number(id)}`;

    async function signIn(email, password) {
      saveSession(await http('POST', '/auth/v1/token?grant_type=password', { body: { email: String(email).trim(), password } }));
    }
    async function signOut() {
      const current = session;
      saveSession(null);
      if (!current) return;
      try {
        await http('POST', '/auth/v1/logout?scope=local', { token: current.access_token });
      } catch (e) { /* الخروج محليًا يكفي */ }
    }
    // سياسة الجدول تُظهر للمستخدم صفّه فقط، فوجود صف معناه أنه مدير للشاشات
    async function isAdmin() {
      const rows = await rest('GET', 'sg_admins?select=user_id&limit=1');
      return Array.isArray(rows) && rows.length > 0;
    }

    // ---------- القراءة ----------
    const mapScreen = (s) => ({
      id: s.id, device_id: s.device_id, name: s.name, branch_id: s.branch_id, location_id: s.location_id, last_seen: toMs(s.last_seen),
    });
    const mapRule = (r) => ({
      id: r.id, branch_id: r.branch_id, location_id: r.location_id, screen_id: r.screen_id, days: r.days || [],
      start_time: hhmm(r.start_time), end_time: hhmm(r.end_time), start_date: r.start_date || null, end_date: r.end_date || null,
    });
    const mapContent = (c) => ({
      id: c.id, title: c.title, type: c.type, file: c.file || null, text: c.text_body || '', url: c.url || '',
      bg: c.bg, fg: c.fg, fit: c.fit, duration: c.duration, sort: c.sort, enabled: c.enabled, updated: toMs(c.updated_at),
      rules: (c.sg_rules || []).map(mapRule),
    });
    const getScreens = () => rest('GET', 'sg_screens?select=id,device_id,name,branch_id,location_id,last_seen&order=id.asc');
    const getPending = () => rest('GET', 'sg_pending?select=code,created_at&order=created_at.desc');

    async function loadState() {
      const [settings, branches, locations, screens, pending, content] = await Promise.all([
        rest('GET', 'sg_settings?select=key,value'),
        rest('GET', 'sg_branches?select=id,name&order=id.asc'),
        rest('GET', 'sg_locations?select=id,name&order=id.asc'),
        getScreens(),
        getPending(),
        rest('GET', `sg_content?select=${CONTENT_SELECT}&order=sort.asc,id.asc&sg_rules.order=id.asc`),
      ]);
      const tz = (settings.find((s) => s.key === 'tz') || {}).value || 'Africa/Cairo';
      return { tz, branches, locations, screens: screens.map(mapScreen), pending, content: content.map(mapContent) };
    }
    // تحديث خفيف لحالة الاتصال والأكواد المنتظرة
    async function loadLive() {
      const [screens, pending] = await Promise.all([getScreens(), getPending()]);
      return { screens: screens.map(mapScreen), pending };
    }

    // ---------- الفروع والأماكن ----------
    const addNamed = (kind, name) => rest('POST', TABLES[kind], { body: { name }, headers: minimal });
    const renameNamed = (kind, id, name) => rest('PATCH', byId(TABLES[kind], id), { body: { name }, headers: minimal });
    const deleteNamed = (kind, id) => rest('DELETE', byId(TABLES[kind], id), { headers: minimal });

    // ---------- الشاشات ----------
    const pairScreen = (code, s) => rpc('sg_pair_screen', {
      p_code: String(code).trim(), p_name: s.name, p_branch_id: s.branch_id, p_location_id: s.location_id,
    });
    // شاشة برابط خاص بدل الكود: ترجع معرّف الجهاز الذي يوضع في الرابط
    const createScreen = (s) => rpc('sg_create_screen', { p_name: s.name, p_branch_id: s.branch_id, p_location_id: s.location_id });
    const updateScreen = (id, s) => rest('PATCH', byId('sg_screens', id), {
      body: { name: s.name, branch_id: s.branch_id, location_id: s.location_id }, headers: minimal,
    });
    const deleteScreen = (id) => rest('DELETE', byId('sg_screens', id), { headers: minimal });
    const clearPending = () => rest('DELETE', 'sg_pending?code=not.is.null', { headers: minimal });

    // ---------- المحتوى ----------
    const replaceRules = (id, rules) => rpc('sg_replace_rules', { p_content_id: id, p_rules: rules });
    async function createContent(row, rules) {
      const created = await rest('POST', 'sg_content?select=id', { body: row, headers: { Prefer: 'return=representation' } });
      const id = created[0].id;
      try {
        await replaceRules(id, rules);
      } catch (e) {
        // لا نترك محتوى بلا قواعد لم يطلبه المستخدم
        await deleteContent(id, null).catch(() => {});
        throw e;
      }
      return id;
    }
    async function updateContent(id, row, rules) {
      await rest('PATCH', byId('sg_content', id), { body: row, headers: minimal });
      await replaceRules(id, rules);
    }
    const setContentEnabled = (id, enabled) => rest('PATCH', byId('sg_content', id), { body: { enabled: !!enabled }, headers: minimal });
    async function deleteContent(id, file) {
      await rest('DELETE', byId('sg_content', id), { headers: minimal });
      if (file) await removeFiles([file]).catch(() => {}); // الصف اتحذف؛ ملف يتيم لا يضر العرض
    }

    // ---------- الملفات ----------
    const objectPath = (path) => String(path).split('/').map(encodeURIComponent).join('/');
    const publicUrl = (path) => (path ? `${base}/storage/v1/object/public/${bucket}/${objectPath(path)}` : null);
    const removeFiles = (paths) => authed('DELETE', `/storage/v1/object/${bucket}`, { body: { prefixes: paths } });
    // الرفع بـ XHR لعرض نسبة التقدّم. مدة التخزين سنة لأن كل رفع له مسار فريد لا يتغير محتواه
    async function upload(path, blob, onProgress) {
      const accessToken = await token();
      return new Promise((resolve, reject) => {
        const form = new FormData();
        form.append('cacheControl', '31536000');
        form.append('', blob);
        const x = new Xhr();
        x.open('POST', `${base}/storage/v1/object/${bucket}/${objectPath(path)}`);
        x.setRequestHeader('apikey', key);
        x.setRequestHeader('Authorization', `Bearer ${accessToken}`);
        x.setRequestHeader('x-upsert', 'false');
        if (x.upload && onProgress) {
          x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
        }
        x.onload = () => {
          let data = null;
          try { data = JSON.parse(x.responseText); } catch (e) { data = null; }
          if (x.status >= 200 && x.status < 300) resolve(path);
          else reject(toError(x.status, data));
        };
        x.onerror = () => reject(new ApiError('network', { kind: 'network' }));
        x.send(form);
      });
    }

    return {
      hasSession: () => !!session,
      signIn, signOut, isAdmin,
      loadState, loadLive,
      addNamed, renameNamed, deleteNamed,
      pairScreen, createScreen, updateScreen, deleteScreen, clearPending,
      createContent, updateContent, setContentEnabled, deleteContent,
      upload, removeFiles, publicUrl,
    };
  }

  return { createClient, ApiError, SESSION_KEY };
});
