// توزيع عناصر «المجموعة» (من 2 إلى 4 صور أو فيديوهات) على الشاشة.
// يُستخدم في المشغّل player.html وفي معاينة الإدارة screens.html ليطابق أحدهما الآخر.
// بصياغة ES5 لأن المشغّل يعمل على متصفحات قديمة.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SignageLayout = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // الشبكات المرشحة: صف واحد، عمود واحد، و2×2 لأربعة عناصر
  function candidates(n, width, height) {
    var row = { rows: 1, cols: n };
    var column = { rows: n, cols: 1 };
    // عند تساوي التغطية: الصف أولى على الشاشة العرضية والعمود على الطولية
    var list = width >= height ? [row, column] : [column, row];
    if (n === 4) list.push({ rows: 2, cols: 2 });
    return list;
  }
  // نسبة مساحة الشاشة التي تغطيها العناصر لو عُرض كل عنصر كاملًا داخل خليته (بلا قص).
  // aspects: نسبة العرض إلى الارتفاع لكل عنصر؛ القيمة غير المعروفة (0) تُعامل كأنها تملأ خليتها
  function fill(aspects, width, height, rows, cols) {
    var cw = width / cols;
    var ch = height / rows;
    var area = 0;
    var i, a;
    for (i = 0; i < aspects.length; i++) {
      a = aspects[i] > 0 ? aspects[i] : cw / ch;
      area += a > cw / ch ? cw * (cw / a) : ch * a * ch;
    }
    return area / (width * height);
  }
  // أفضل شبكة: الأكثر تغطية للشاشة، فتقل الشرائط السوداء (أو القص في وضع «تملأ الشاشة»)
  function choose(aspects, width, height) {
    var list = candidates(aspects.length, width, height);
    var best = null;
    var i, f;
    for (i = 0; i < list.length; i++) {
      f = fill(aspects, width, height, list[i].rows, list[i].cols);
      if (!best || f > best.fill + 0.001) best = { rows: list[i].rows, cols: list[i].cols, fill: f };
    }
    return best;
  }
  // مواضع الخلايا بالنسبة المئوية من الشاشة. العنصر الأول على اليمين (اتجاه القراءة العربي)
  function cells(n, rows, cols) {
    var out = [];
    var i;
    for (i = 0; i < n; i++) {
      out.push({
        right: (i % cols) * (100 / cols),
        top: Math.floor(i / cols) * (100 / rows),
        width: 100 / cols,
        height: 100 / rows
      });
    }
    return out;
  }

  return { candidates: candidates, fill: fill, choose: choose, cells: cells };
});
