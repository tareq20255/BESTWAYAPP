'use strict';
// اختيار الأوردرات المراد طباعتها من بين الأوردرات المقروءة. نحفظ «المستبعَدة» فقط
// (الافتراضي: الكل محدد) بمفتاح ثابت يبقى صالحًا لو تغيّر النص أو ترتيب الأوردرات.

// الأوردر برقمه المرجعي، وبدونه نستخدم محتواه (الأصناف والإجمالي)
function orderKey(order) {
  if (order.ref) return order.ref;
  const items = order.items.map((item) => `${item.code}x${item.qty}`).join(',');
  return `#${items}|${order.total}`;
}

// الأوردرات المحددة (غير المستبعَدة) بنفس الترتيب
function selectedOrders(orders, excluded) {
  return orders.filter((order) => !excluded.has(orderKey(order)));
}

const excludeAll = (orders) => new Set(orders.map(orderKey));

// تحديد غير المطبوع فقط: نستبعد كل أوردر رقمه ضمن المطبوع سابقًا (printed: Map(ref → وقت))
function excludePrinted(orders, printed) {
  return new Set(orders.filter((order) => order.ref && printed.has(order.ref)).map(orderKey));
}

// يحذف المفاتيح التي لم تعد موجودة. يرجع نفس الـ Set لو لم يتغير شيء (لتجنب إعادة رسم بلا داعٍ)
function pruneExcluded(excluded, orders) {
  if (!excluded.size) return excluded;
  const live = new Set(orders.map(orderKey));
  const kept = [...excluded].filter((key) => live.has(key));
  return kept.length === excluded.size ? excluded : new Set(kept);
}

// يقلب حالة أوردر واحد ويرجع Set جديدًا
function toggleOrder(excluded, order) {
  const next = new Set(excluded);
  const key = orderKey(order);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

module.exports = { orderKey, selectedOrders, excludeAll, excludePrinted, pruneExcluded, toggleOrder };
