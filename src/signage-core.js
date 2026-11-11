'use strict';
// منطق الشاشات المستقل عن المتصفح: الاستهداف والجدولة والتحقق من المدخلات ورسائل الأخطاء.
// الجدولة هنا نسخة من الدالة sg_private.rule_active في القاعدة (supabase/signage_setup.sql)
// وتُستخدم للمعاينة داخل صفحة الإدارة فقط؛ الشاشات نفسها تأخذ القائمة جاهزة من القاعدة.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignageCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ترتيب العرض يبدأ بالسبت. الرقم هو يوم الأسبوع (0 = الأحد … 6 = السبت) كما في القاعدة
  const DAYS = [[6, 'السبت'], [0, 'الأحد'], [1, 'الإثنين'], [2, 'الثلاثاء'], [3, 'الأربعاء'], [4, 'الخميس'], [5, 'الجمعة']];
  const TYPES = ['image', 'video', 'text', 'url', 'group'];
  const SMALL_MEDIA_PX = 1000; // أقل من ذلك للضلع الأطول يظهر ناعمًا على شاشة كبيرة
  const MAX_FILE_BYTES = 50 * 1024 * 1024; // نفس حد المخزن signage
  const MIME_BY_EXT = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', webm: 'video/webm',
  };
  const ONLINE_MS = 150000; // الشاشة تتصل كل دقيقة: نعتبرها متصلة لو آخر اتصال خلال دقيقتين ونصف

  function inputError(message) {
    const e = new Error(message);
    e.kind = 'input';
    return e;
  }

  // ---------- الوقت ----------
  // الوقت الحالي بتوقيت الفروع (وليس توقيت الجهاز)
  function nowParts(ms, tz) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const p = {};
    for (const x of parts) p[x.type] = x.value;
    return atParts(`${p.year}-${p.month}-${p.day}`, `${p.hour}:${p.minute}`);
  }
  // وقت محدد يدويًا (للمعاينة): تاريخ YYYY-MM-DD وساعة HH:MM
  function atParts(date, time) {
    return { date, time, day: new Date(`${date}T00:00:00Z`).getUTCDay() };
  }
  function prevDate(date) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
  }
  // القاعدة ترجع الوقت "22:00:00" وحقل الإدخال يريد "22:00"
  const hhmm = (t) => (t ? String(t).slice(0, 5) : null);

  // ---------- الاستهداف والجدولة ----------
  // اتجاه الشاشة الفعلي: المثبّت يدويًا، وإلا من المقاس الذي أرسلته الشاشة، وإلا عرضي
  // (نسخة من sg_private.screen_orientation في القاعدة)
  function screenOrientation(screen) {
    if (screen.orientation === 'landscape' || screen.orientation === 'portrait') return screen.orientation;
    return screen.view_w && screen.view_h && screen.view_h > screen.view_w ? 'portrait' : 'landscape';
  }
  // نسبة العرض إلى الارتفاع لإطار المعاينة
  function screenAspect(screen) {
    const portrait = screenOrientation(screen) === 'portrait';
    if (screen.view_w && screen.view_h && (screen.view_h > screen.view_w) === portrait) return screen.view_w / screen.view_h;
    return portrait ? 9 / 16 : 16 / 9;
  }
  // حقل فارغ في القاعدة معناه «الكل»
  function ruleMatchesScreen(rule, screen) {
    return (rule.branch_id == null || rule.branch_id === screen.branch_id)
      && (rule.location_id == null || rule.location_id === screen.location_id)
      && (rule.screen_id == null || rule.screen_id === screen.id)
      && (rule.orientation == null || rule.orientation === screenOrientation(screen));
  }
  function ruleActiveNow(rule, now) {
    let day = now.day;
    let date = now.date;
    const start = rule.start_time;
    const end = rule.end_time;
    if (start && end) {
      if (start <= end) {
        if (now.time < start || now.time >= end) return false;
      } else if (now.time >= start) {
        // نافذة تعدّي منتصف الليل (22:00 → 02:00) ونحن في جزئها الأول
      } else if (now.time < end) {
        // بعد منتصف الليل: الفترة تتبع يوم بدايتها
        day = (day + 6) % 7;
        date = prevDate(date);
      } else {
        return false;
      }
    } else if (start && now.time < start) {
      return false;
    } else if (end && now.time >= end) {
      return false;
    }
    if (rule.days && rule.days.length && !rule.days.includes(day)) return false;
    if (rule.start_date && date < rule.start_date) return false;
    if (rule.end_date && date > rule.end_date) return false;
    return true;
  }
  // ما تعرضه شاشة في وقت معين: المحتوى المفعّل الذي له قاعدة واحدة على الأقل تطابق الشاشة وسارية الآن
  function playlistFor(content, screen, now) {
    return content
      .filter((c) => c.enabled)
      .sort((a, b) => a.sort - b.sort || a.id - b.id)
      .filter((c) => c.rules.some((r) => ruleMatchesScreen(r, screen) && ruleActiveNow(r, now)));
  }

  // ---------- المدخلات ----------
  const emptyRule = () => ({
    branch_id: null, location_id: null, screen_id: null, orientation: null, days: [],
    start_time: null, end_time: null, start_date: null, end_date: null,
  });
  const idOrNull = (v) => (v === null || v === undefined || v === '' || Number(v) === 0 ? null : Number(v));
  function normalizeRule(r) {
    const days = [...new Set((r.days || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    return {
      branch_id: idOrNull(r.branch_id), location_id: idOrNull(r.location_id), screen_id: idOrNull(r.screen_id),
      orientation: r.orientation === 'landscape' || r.orientation === 'portrait' ? r.orientation : null,
      days,
      start_time: hhmm(r.start_time), end_time: hhmm(r.end_time),
      start_date: r.start_date || null, end_date: r.end_date || null,
    };
  }
  // يجهّز القواعد للحفظ ويرفض ما لا يمكن أن يعمل
  function normalizeRules(rules) {
    return (rules || []).map((raw, i) => {
      const r = normalizeRule(raw);
      const n = i + 1;
      if (r.start_time && r.end_time && r.start_time === r.end_time) {
        throw inputError(`قاعدة ${n}: وقت البداية والنهاية متساويين. سيبهم فاضيين لو عايزه طول اليوم.`);
      }
      if (r.start_date && r.end_date && r.start_date > r.end_date) {
        throw inputError(`قاعدة ${n}: تاريخ البداية بعد تاريخ النهاية`);
      }
      return r;
    });
  }
  function cleanName(value, label) {
    const s = String(value == null ? '' : value).trim();
    if (!s) throw inputError(`اكتب ${label}`);
    if (s.length > 80) throw inputError(`${label} طويل جدًا`);
    return s;
  }
  const isColor = (v) => /^#[0-9a-fA-F]{6}$/.test(v || '');
  // حقول صف sg_content من نموذج الإدخال (بدون الملف)
  function contentRow(type, form) {
    if (!TYPES.includes(type)) throw inputError('نوع المحتوى غير معروف');
    const row = {
      title: cleanName(form.title, 'عنوان للمحتوى'),
      type,
      duration: Math.min(3600, Math.max(3, Math.round(Number(form.duration)) || 10)),
      fit: form.fit === 'cover' ? 'cover' : 'contain',
      sort: Math.round(Number(form.sort)) || 0,
      text_body: null,
      url: null,
      bg: isColor(form.bg) ? form.bg : '#111111',
      fg: isColor(form.fg) ? form.fg : '#ffffff',
    };
    if (type === 'text') {
      row.text_body = String(form.text == null ? '' : form.text).trim();
      if (!row.text_body) throw inputError('اكتب النص اللي هيظهر على الشاشة');
      if (row.text_body.length > 2000) throw inputError('النص طويل جدًا (الحد 2000 حرف)');
    }
    if (type === 'url') {
      row.url = String(form.url == null ? '' : form.url).trim();
      if (!/^https?:\/\/\S+$/i.test(row.url)) throw inputError('الرابط لازم يبدأ بـ https://');
    }
    return row;
  }

  // ---------- الملفات ----------
  // نوع الملف من الـ MIME وإلا من الامتداد (بعض متصفحات أندرويد لا ترسل النوع)
  function fileInfo(file, type) {
    if (!file) throw inputError('اختار الملف الأول');
    const ext = (/\.([a-z0-9]+)$/i.exec(file.name || '') || [])[1];
    const known = Object.values(MIME_BY_EXT);
    const mime = known.includes(file.type) ? file.type : MIME_BY_EXT[String(ext || '').toLowerCase()];
    if (!mime) throw inputError('نوع الملف مش مدعوم. الصور: JPG أو PNG أو WebP أو GIF. الفيديو: MP4 أو WebM.');
    const kind = mime.split('/')[0];
    if (type && type !== 'group' && kind !== type) throw inputError(type === 'image' ? 'الملف ده مش صورة' : 'الملف ده مش فيديو');
    if (file.size > MAX_FILE_BYTES) throw inputError('الملف أكبر من 50 ميجا. اضغط الفيديو أو قصّره وجرّب تاني.');
    const outExt = Object.keys(MIME_BY_EXT).find((k) => MIME_BY_EXT[k] === mime);
    return { kind, mime, ext: outExt };
  }
  // مسار فريد لكل رفع، فيمكن تخزين الملف في المتصفح لمدة طويلة بأمان
  function storagePath(ext, nowMs, random) {
    const stamp = new Date(nowMs).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const tail = Math.floor((random === undefined ? Math.random() : random) * 0xffffffff).toString(36).padStart(7, '0');
    return `c/${stamp}-${tail}.${ext}`;
  }
  // «العرض×الارتفاع» كوحدة من اليسار لليمين داخل نص عربي؛ بدون العزل يظهر الرقمان معكوسين (640×360 بدل 360×640)
  const dims = (width, height) => `\u2066${width}×${height}\u2069`;
  // وصف مقاس ملف للمستخدم: اتجاهه، وهل هو صغير على شاشة عرض
  function mediaShape(width, height) {
    const orientation = width === height ? 'square' : (height > width ? 'portrait' : 'landscape');
    const name = { portrait: 'طولي', landscape: 'عرضي', square: 'مربع' }[orientation];
    return { orientation, small: Math.max(width, height) < SMALL_MEDIA_PX, label: `${name} ${dims(width, height)}` };
  }
  function sizeText(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} م.ب`;
    return `${Math.max(1, Math.round(bytes / 1024))} ك.ب`;
  }

  // ---------- العرض ----------
  const isOnline = (lastSeenMs, nowMs) => !!lastSeenMs && nowMs - lastSeenMs < ONLINE_MS;
  function agoText(lastSeenMs, nowMs) {
    if (!lastSeenMs) return 'لم تتصل بعد';
    const s = Math.max(0, (nowMs - lastSeenMs) / 1000);
    if (s < ONLINE_MS / 1000) return 'متصلة الآن';
    if (s < 3600) return `آخر اتصال منذ ${Math.round(s / 60)} دقيقة`;
    if (s < 86400) return `آخر اتصال منذ ${Math.round(s / 3600)} ساعة`;
    return `آخر اتصال منذ ${Math.round(s / 86400)} يوم`;
  }
  // وصف القاعدة للقراءة: «فين» و«إمتى»
  function ruleSummary(rule, state) {
    const nameOf = (list, id) => (list.find((x) => x.id === id) || {}).name;
    const where = [nameOf(state.branches, rule.branch_id) || 'كل الفروع', nameOf(state.locations, rule.location_id) || 'كل الأماكن'];
    if (rule.screen_id) where.push(`شاشة: ${nameOf(state.screens, rule.screen_id) || '؟'}`);
    if (rule.orientation) where.push(rule.orientation === 'portrait' ? 'الشاشات الطولية' : 'الشاشات العرضية');
    const when = [];
    if (rule.days.length && rule.days.length < 7) when.push(DAYS.filter(([d]) => rule.days.includes(d)).map(([, n]) => n).join('، '));
    if (rule.start_time || rule.end_time) when.push(`${rule.start_time || '00:00'}–${rule.end_time || '24:00'}`);
    if (rule.start_date || rule.end_date) when.push(`${rule.start_date || '…'} → ${rule.end_date || '…'}`);
    return { where: where.join(' · '), when: when.join(' | ') };
  }

  // رسالة عربية مفهومة من خطأ Supabase (PostgREST / Auth / Storage) أو خطأ إدخال
  function errorText(e) {
    if (!e) return 'حصل خطأ';
    if (e.kind === 'input') return e.message;
    if (e.kind === 'network') return 'مفيش اتصال بالإنترنت. جرّب تاني.';
    if (e.kind === 'auth') return 'سجّل الدخول من جديد';
    switch (String(e.code)) {
      case '23505': return 'الاسم ده موجود قبل كده';
      case '23503': return 'مستخدم في شاشات أو قواعد عرض. شيله منها الأول.';
      case '23514': case '22001': case '22P02': case '22007': case '22008':
        return 'في قيمة مش مقبولة. راجع البيانات وجرّب تاني.';
      case '42501': return 'الحساب ده مالوش صلاحية على الشاشات';
      // عمود أو دالة غير موجودة: الصفحة أحدث من القاعدة
      case '42703': case 'PGRST204': case 'PGRST202':
        return 'القاعدة محتاجة تحديث: شغّل ملف signage_update_2.sql من Supabase وجرّب تاني.';
      case 'P0001': return e.message; // رسالة مكتوبة في دوال القاعدة، مثل «الكود غير صحيح أو منتهي»
      case 'invalid_credentials': case 'invalid_grant': return 'الإيميل أو كلمة السر غلط';
      case 'email_not_confirmed': return 'الإيميل ده لسه متأكدش من Supabase';
      case 'over_request_rate_limit': return 'محاولات كتير. استنى دقيقة وجرّب تاني.';
      default:
    }
    if (e.status === 413) return 'الملف أكبر من الحد المسموح (50 ميجا)';
    if (e.status === 415 || /mime/i.test(e.message || '')) return 'نوع الملف مش مدعوم';
    if (e.status === 429) return 'محاولات كتير. استنى دقيقة وجرّب تاني.';
    if (e.status === 403) return 'الحساب ده مالوش صلاحية على الشاشات';
    return e.message ? `حصل خطأ: ${e.message}` : 'حصل خطأ';
  }

  return {
    DAYS, TYPES, MAX_FILE_BYTES, ONLINE_MS,
    inputError, nowParts, atParts, prevDate, hhmm,
    screenOrientation, screenAspect, ruleMatchesScreen, ruleActiveNow, playlistFor,
    emptyRule, normalizeRule, normalizeRules, cleanName, contentRow,
    fileInfo, storagePath, dims, mediaShape, sizeText,
    isOnline, agoText, ruleSummary, errorText,
  };
});
