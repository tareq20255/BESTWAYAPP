// إعدادات الاتصال بمشروع Supabase الخاص بالشاشات (bestway-ops).
// المفتاح من نوع publishable: مخصص للنشر في كود الواجهة، والحماية الفعلية من صلاحيات RLS في القاعدة
// (supabase/signage_setup.sql). لا تضع هنا أي مفتاح سري (sb_secret_…).
// الملف يُحمَّل أيضًا في player.html على متصفحات قديمة، فيبقى بصياغة ES5.
(function (root) {
  var config = {
    url: 'https://opdzhuavwctvohvlyhsa.supabase.co',
    key: 'sb_publishable_bREZfWOAioDEsfm03fNyJg_iv4x3he8',
    bucket: 'signage'
  };
  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.SIGNAGE_CONFIG = config;
})(typeof self !== 'undefined' ? self : this);
