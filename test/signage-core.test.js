const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/signage-core');

const rule = (extra) => Object.assign(core.emptyRule(), extra);
// 2026-11-09 يوم إثنين (1)
const MON = '2026-11-09';
const TUE = '2026-11-10';

test('ruleActiveNow: نافذة تعدّي منتصف الليل تتبع يوم بدايتها (نفس حالات دالة القاعدة)', () => {
  const night = rule({ days: [1], start_time: '22:00', end_time: '02:00' });
  assert.equal(core.ruleActiveNow(night, core.atParts(MON, '23:00')), true, 'الإثنين 23:00');
  assert.equal(core.ruleActiveNow(night, core.atParts(TUE, '01:00')), true, 'الثلاثاء 01:00 تابع لليلة الإثنين');
  assert.equal(core.ruleActiveNow(night, core.atParts(MON, '01:00')), false, 'الإثنين 01:00 تابع لليلة الأحد');
  assert.equal(core.ruleActiveNow(night, core.atParts(TUE, '02:00')), false, '02:00 بالضبط خارج النافذة');
  assert.equal(core.ruleActiveNow(night, core.atParts(MON, '12:00')), false, 'منتصف النهار');
});

test('ruleActiveNow: نافذة عادية، بداية فقط، نهاية فقط', () => {
  const day = rule({ start_time: '09:00', end_time: '17:00' });
  assert.equal(core.ruleActiveNow(day, core.atParts(MON, '09:00')), true);
  assert.equal(core.ruleActiveNow(day, core.atParts(MON, '16:59')), true);
  assert.equal(core.ruleActiveNow(day, core.atParts(MON, '17:00')), false);
  assert.equal(core.ruleActiveNow(day, core.atParts(MON, '08:59')), false);
  assert.equal(core.ruleActiveNow(rule({ start_time: '18:00' }), core.atParts(MON, '17:59')), false);
  assert.equal(core.ruleActiveNow(rule({ start_time: '18:00' }), core.atParts(MON, '18:00')), true);
  assert.equal(core.ruleActiveNow(rule({ end_time: '11:00' }), core.atParts(MON, '10:59')), true);
  assert.equal(core.ruleActiveNow(rule({ end_time: '11:00' }), core.atParts(MON, '11:00')), false);
});

test('ruleActiveNow: الأيام والتواريخ، والقاعدة الفارغة سارية دائمًا', () => {
  assert.equal(core.ruleActiveNow(rule({}), core.atParts(MON, '03:00')), true);
  assert.equal(core.ruleActiveNow(rule({ days: [5] }), core.atParts(MON, '12:00')), false);
  assert.equal(core.ruleActiveNow(rule({ days: [5] }), core.atParts('2026-11-13', '12:00')), true, 'الجمعة');
  const ramadan = rule({ start_date: '2027-02-08', end_date: '2027-03-09' });
  assert.equal(core.ruleActiveNow(ramadan, core.atParts(MON, '12:00')), false);
  assert.equal(core.ruleActiveNow(ramadan, core.atParts('2027-02-08', '00:00')), true);
  assert.equal(core.ruleActiveNow(ramadan, core.atParts('2027-03-09', '23:59')), true);
  assert.equal(core.ruleActiveNow(ramadan, core.atParts('2027-03-10', '00:00')), false);
  // نافذة ليلية في آخر يوم من المدة تكمل بعد منتصف الليل
  const lastNight = rule({ start_time: '22:00', end_time: '02:00', end_date: MON });
  assert.equal(core.ruleActiveNow(lastNight, core.atParts(TUE, '01:30')), true);
  assert.equal(core.ruleActiveNow(lastNight, core.atParts(TUE, '22:30')), false);
});

test('nowParts: يحسب بتوقيت الفروع وليس توقيت الجهاز', () => {
  // 21:30 UTC = 23:30 في القاهرة (UTC+2 في نوفمبر)
  assert.deepEqual(core.nowParts(Date.UTC(2026, 10, 9, 21, 30), 'Africa/Cairo'), { date: MON, time: '23:30', day: 1 });
  // 23:30 UTC يوم الإثنين = 01:30 الثلاثاء في القاهرة
  assert.deepEqual(core.nowParts(Date.UTC(2026, 10, 9, 23, 30), 'Africa/Cairo'), { date: TUE, time: '01:30', day: 2 });
  assert.equal(core.prevDate('2026-03-01'), '2026-02-28');
});

test('playlistFor: الاستهداف بالفرع والمكان والشاشة، بلا تكرار وبالترتيب', () => {
  const s1 = { id: 1, branch_id: 10, location_id: 20 };
  const s2 = { id: 2, branch_id: 10, location_id: 21 };
  const s3 = { id: 3, branch_id: 11, location_id: 20 };
  const item = (id, sort, rules, enabled = true) => ({ id, sort, enabled, rules });
  const content = [
    item(7, 7, [rule({}), rule({ days: [0, 1, 2, 3, 4, 5, 6] })]), // قاعدتان تنطبقان: يظهر مرة واحدة
    item(1, 1, [rule({})]),
    item(2, 2, [rule({ branch_id: 10 })]),
    item(3, 3, [rule({ location_id: 20 })]),
    item(4, 4, [rule({ screen_id: 2 })]),
    item(5, 5, [rule({})], false), // متوقف
    item(6, 6, []), // بلا قواعد
  ];
  const now = core.atParts(MON, '12:00');
  const ids = (s) => core.playlistFor(content, s, now).map((c) => c.id);
  assert.deepEqual(ids(s1), [1, 2, 3, 7]);
  assert.deepEqual(ids(s2), [1, 2, 4, 7]);
  assert.deepEqual(ids(s3), [1, 3, 7]);
  // فرع ومكان معًا: الشرطان مطلوبان
  const both = [item(9, 0, [rule({ branch_id: 11, location_id: 21 })])];
  assert.deepEqual(core.playlistFor(both, s3, now), []);
  assert.deepEqual(core.playlistFor(both, { id: 4, branch_id: 11, location_id: 21 }, now).map((c) => c.id), [9]);
});

test('اتجاه الشاشة: يدوي، ثم من مقاسها، ثم عرضي؛ والقاعدة تستهدف اتجاهًا', () => {
  assert.equal(core.screenOrientation({ orientation: 'auto', view_w: 1080, view_h: 1920 }), 'portrait');
  assert.equal(core.screenOrientation({ orientation: 'auto', view_w: 1920, view_h: 1080 }), 'landscape');
  assert.equal(core.screenOrientation({ orientation: 'auto', view_w: null, view_h: null }), 'landscape', 'شاشة لم تتصل بعد');
  assert.equal(core.screenOrientation({ orientation: 'auto', view_w: 1000, view_h: 1000 }), 'landscape', 'المربع يُعامل كعرضي كما في القاعدة');
  assert.equal(core.screenOrientation({ orientation: 'portrait', view_w: 1920, view_h: 1080 }), 'portrait', 'التثبيت اليدوي يغلب');
  assert.equal(core.screenOrientation({}), 'landscape');
  assert.equal(core.screenAspect({ orientation: 'auto', view_w: 1280, view_h: 800 }), 1.6);
  assert.equal(core.screenAspect({ orientation: 'auto' }), 16 / 9);
  assert.equal(core.screenAspect({ orientation: 'portrait' }), 9 / 16);
  assert.equal(core.screenAspect({ orientation: 'portrait', view_w: 1920, view_h: 1080 }), 9 / 16, 'مقاس يخالف التثبيت اليدوي لا يُستخدم');

  const tall = { id: 1, branch_id: 1, location_id: 1, orientation: 'auto', view_w: 1080, view_h: 1920 };
  const wide = { id: 2, branch_id: 1, location_id: 1, orientation: 'auto', view_w: 1920, view_h: 1080 };
  const item = (id, orientation) => ({ id, sort: id, enabled: true, rules: [rule({ orientation })] });
  const content = [item(1, 'portrait'), item(2, 'landscape'), item(3, null)];
  const now = core.atParts(MON, '12:00');
  assert.deepEqual(core.playlistFor(content, tall, now).map((c) => c.id), [1, 3]);
  assert.deepEqual(core.playlistFor(content, wide, now).map((c) => c.id), [2, 3]);
  assert.deepEqual(core.playlistFor(content, Object.assign({}, wide, { orientation: 'portrait' }), now).map((c) => c.id), [1, 3]);
});

test('mediaShape: اتجاه الملف وتنبيه المقاس الصغير', () => {
  // المقاس معزول الاتجاه (LRI … PDI) حتى لا ينعكس الرقمان داخل النص العربي
  const ltr = (text) => `\u2066${text}\u2069`;
  assert.equal(core.dims(360, 640), ltr('360×640'));
  assert.deepEqual(core.mediaShape(360, 640), { orientation: 'portrait', small: true, label: `طولي ${ltr('360×640')}` });
  assert.deepEqual(core.mediaShape(1920, 1080), { orientation: 'landscape', small: false, label: `عرضي ${ltr('1920×1080')}` });
  assert.deepEqual(core.mediaShape(1080, 1080), { orientation: 'square', small: false, label: `مربع ${ltr('1080×1080')}` });
  assert.equal(core.mediaShape(1280, 720).small, false);
  assert.equal(core.mediaShape(854, 480).small, true);
});

test('normalizeRules: تنظيف القيم ورفض ما لا يعمل', () => {
  const [r] = core.normalizeRules([{ branch_id: '3', location_id: '', screen_id: 0, days: ['5', 5, 1, 9], start_time: '22:00:00', end_time: '02:00:00', start_date: '', end_date: '2027-01-01' }]);
  assert.deepEqual(r, { branch_id: 3, location_id: null, screen_id: null, orientation: null, days: [1, 5], start_time: '22:00', end_time: '02:00', start_date: null, end_date: '2027-01-01' });
  assert.equal(core.normalizeRule({ orientation: 'portrait' }).orientation, 'portrait');
  assert.equal(core.normalizeRule({ orientation: 'diagonal' }).orientation, null);
  assert.equal(core.normalizeRule({ orientation: '' }).orientation, null);
  assert.throws(() => core.normalizeRules([rule({ start_time: '10:00', end_time: '10:00' })]), /قاعدة 1.*متساويين/);
  assert.throws(() => core.normalizeRules([rule({}), rule({ start_date: '2027-02-01', end_date: '2027-01-01' })]), /قاعدة 2/);
  assert.deepEqual(core.normalizeRules(undefined), []);
});

test('contentRow: الحقول حسب النوع والتحقق منها', () => {
  const text = core.contentRow('text', { title: '  عرض  ', text: ' أهلًا ', duration: '1', sort: '2', bg: '#ABCDEF', fg: 'red', fit: 'cover' });
  assert.deepEqual(text, { title: 'عرض', type: 'text', duration: 3, fit: 'cover', sort: 2, text_body: 'أهلًا', url: null, bg: '#ABCDEF', fg: '#ffffff' });
  assert.equal(core.contentRow('image', { title: 'ص', duration: 99999 }).duration, 3600);
  assert.equal(core.contentRow('image', { title: 'ص', duration: 'x' }).duration, 10);
  assert.equal(core.contentRow('url', { title: 'ر', url: ' https://example.com/a ' }).url, 'https://example.com/a');
  assert.throws(() => core.contentRow('text', { title: 'ع', text: '   ' }), /اكتب النص/);
  assert.throws(() => core.contentRow('url', { title: 'ع', url: 'example.com' }), /https/);
  assert.throws(() => core.contentRow('url', { title: 'ع', url: 'javascript:alert(1)' }), /https/);
  assert.throws(() => core.contentRow('image', { title: ' ' }), /عنوان/);
  assert.throws(() => core.contentRow('pdf', { title: 'ع' }), /نوع المحتوى/);
  assert.equal(core.contentRow('text', { title: 'ع', text: 'x' }).text_body, 'x');
  assert.throws(() => core.cleanName('ا'.repeat(81), 'اسم الفرع'), /طويل/);
  assert.equal(core.inputError('x').kind, 'input');
});

test('fileInfo: النوع من الـ MIME أو الامتداد، والحجم والتطابق مع النوع المختار', () => {
  assert.deepEqual(core.fileInfo({ name: 'a.JPG', type: 'image/jpeg', size: 10 }, 'image'), { kind: 'image', mime: 'image/jpeg', ext: 'jpg' });
  assert.deepEqual(core.fileInfo({ name: 'clip.MP4', type: '', size: 10 }, 'video'), { kind: 'video', mime: 'video/mp4', ext: 'mp4' });
  assert.throws(() => core.fileInfo({ name: 'a.heic', type: 'image/heic', size: 10 }, 'image'), /مش مدعوم/);
  assert.throws(() => core.fileInfo({ name: 'a.mp4', type: 'video/mp4', size: 10 }, 'image'), /مش صورة/);
  assert.throws(() => core.fileInfo({ name: 'a.png', type: 'image/png', size: 10 }, 'video'), /مش فيديو/);
  assert.throws(() => core.fileInfo({ name: 'a.mp4', type: 'video/mp4', size: core.MAX_FILE_BYTES + 1 }, 'video'), /50 ميجا/);
  assert.throws(() => core.fileInfo(undefined, 'image'), /اختار الملف/);
  // المجموعة تقبل الصور والفيديو معًا
  assert.equal(core.fileInfo({ name: 'a.mp4', type: 'video/mp4', size: 10 }, 'group').kind, 'video');
  assert.equal(core.fileInfo({ name: 'a.png', type: 'image/png', size: 10 }, 'group').kind, 'image');
  assert.throws(() => core.fileInfo({ name: 'a.pdf', type: 'application/pdf', size: 10 }, 'group'), /مش مدعوم/);
  assert.equal(core.contentRow('group', { title: 'مجموعة', duration: 8, fit: 'cover' }).type, 'group');
});

test('storagePath: مسار فريد مقبول في المخزن', () => {
  const a = core.storagePath('jpg', Date.UTC(2026, 10, 11, 10, 30, 5), 0.5);
  assert.match(a, /^c\/20261111103005-[0-9a-z]{7}\.jpg$/);
  assert.notEqual(core.storagePath('jpg', 1), core.storagePath('jpg', 1));
  assert.ok(!core.storagePath('mp4', Date.now()).includes('..'));
  assert.equal(core.sizeText(5.25 * 1024 * 1024), '5.3 م.ب');
  assert.equal(core.sizeText(430 * 1024), '430 ك.ب');
});

test('حالة الاتصال ووصف القاعدة', () => {
  const now = 1_000_000_000;
  assert.equal(core.isOnline(now - 100_000, now), true);
  assert.equal(core.isOnline(now - core.ONLINE_MS, now), false);
  assert.equal(core.isOnline(null, now), false);
  assert.equal(core.agoText(null, now), 'لم تتصل بعد');
  assert.equal(core.agoText(now - 30_000, now), 'متصلة الآن');
  assert.equal(core.agoText(now - 10 * 60_000, now), 'آخر اتصال منذ 10 دقيقة');
  assert.equal(core.agoText(now - 3 * 3600_000, now), 'آخر اتصال منذ 3 ساعة');
  const state = { branches: [{ id: 1, name: 'المعادي' }], locations: [{ id: 2, name: 'كاشير' }], screens: [{ id: 3, name: 'كاشير 1' }] };
  assert.deepEqual(core.ruleSummary(rule({}), state), { where: 'كل الفروع · كل الأماكن', when: '' });
  assert.deepEqual(
    core.ruleSummary(rule({ branch_id: 1, location_id: 2, screen_id: 3, days: [5, 6], start_time: '22:00', end_time: '02:00' }), state),
    { where: 'المعادي · كاشير · شاشة: كاشير 1', when: 'السبت، الجمعة | 22:00–02:00' },
  );
  assert.equal(core.ruleSummary(rule({ orientation: 'portrait' }), state).where, 'كل الفروع · كل الأماكن · الشاشات الطولية');
  assert.equal(core.ruleSummary(rule({ orientation: 'landscape' }), state).where, 'كل الفروع · كل الأماكن · الشاشات العرضية');
});

test('errorText: رسائل مفهومة لأخطاء Supabase', () => {
  assert.equal(core.errorText(core.inputError('اكتب اسم الفرع')), 'اكتب اسم الفرع');
  assert.match(core.errorText({ kind: 'network' }), /مفيش اتصال/);
  assert.match(core.errorText({ code: '23505', message: 'duplicate key' }), /موجود قبل كده/);
  assert.match(core.errorText({ code: '23503', message: 'fk' }), /مستخدم في شاشات/);
  assert.equal(core.errorText({ code: 'P0001', message: 'الكود غير صحيح أو منتهي' }), 'الكود غير صحيح أو منتهي');
  assert.match(core.errorText({ code: 'invalid_credentials', status: 400 }), /كلمة السر غلط/);
  assert.match(core.errorText({ code: '42501', status: 403 }), /صلاحية/);
  for (const code of ['42703', 'PGRST204', 'PGRST202']) assert.match(core.errorText({ code, status: 400 }), /signage_update_2\.sql/);
  assert.match(core.errorText({ status: 413, message: 'too large' }), /50 ميجا/);
  assert.match(core.errorText({ status: 400, code: 'invalid_mime_type', message: 'mime type image/heic is not supported' }), /مش مدعوم/);
  assert.equal(core.errorText({ status: 500, message: 'boom' }), 'حصل خطأ: boom');
  assert.equal(core.errorText(null), 'حصل خطأ');
});
