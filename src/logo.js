'use strict';
// شعار الإيصال: تحويل أي صورة إلى أبيض وأسود مناسب للطابعة الحرارية بحجم صغير.
// نمطان: «حاد» (عتبة Otsu، للشعارات البسيطة) و«تدرّج» (تنقيط Floyd–Steinberg، للصور)، مع خيار عكس الألوان.
// الدوال النقية (fitSize / toGrayscale / otsuThreshold / ditherFloydSteinberg / toMonochrome) تُختبر في Node؛
// processLogoFile / reprocessLogo يحتاجان المتصفح (canvas) ويُمرَّر لهما env للاختبار عند الحاجة.

const LOGO_MAX_W = 384;
const LOGO_MAX_H = 192;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 200000;

// يصغّر مع الحفاظ على النسبة ولا يكبّر أبدًا
function fitSize(width, height, maxW = LOGO_MAX_W, maxH = LOGO_MAX_H) {
  const scale = Math.min(1, maxW / width, maxH / height);
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

// رمادي لكل بكسل مع اعتبار الشفافية فوق خلفية بيضاء
function toGrayscale(rgba) {
  const gray = new Uint8Array(rgba.length / 4);
  for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
    const alpha = rgba[i + 3] / 255;
    const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    gray[p] = Math.round(lum * alpha + 255 * (1 - alpha));
  }
  return gray;
}

// عتبة Otsu: القيمة التي تفصل الأسود عن الأبيض بأقل تداخل. بكسل <= العتبة يصير أسود
function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (const g of gray) hist[g]++;
  const total = gray.length;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let sumBack = 0;
  let weightBack = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    weightBack += hist[t];
    if (!weightBack) continue;
    const weightFore = total - weightBack;
    if (!weightFore) break;
    sumBack += t * hist[t];
    const meanBack = sumBack / weightBack;
    const meanFore = (sumAll - sumBack) / weightFore;
    const between = weightBack * weightFore * (meanBack - meanFore) ** 2;
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return best;
}

// تمديد التباين: أغمق بكسل يصير 0 وأفتح بكسل 255 (يحسّن التنقيط للصور الباهتة)
function stretchLevels(gray, min, max) {
  const out = new Uint8Array(gray.length);
  const range = max - min;
  for (let i = 0; i < gray.length; i++) out[i] = Math.round(((gray[i] - min) * 255) / range);
  return out;
}

// تنقيط Floyd–Steinberg: يوزّع خطأ التقريب على الجيران فتظهر التدرجات كنقاط. gray بعرض width
function ditherFloydSteinberg(gray, width, threshold = 128) {
  const height = gray.length / width;
  const buf = Float32Array.from(gray);
  const out = new Uint8Array(gray.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const old = buf[i];
      const value = old < threshold ? 0 : 255;
      out[i] = value;
      const err = old - value;
      if (x + 1 < width) buf[i + 1] += (err * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) buf[i + width - 1] += (err * 3) / 16;
        buf[i + width] += (err * 5) / 16;
        if (x + 1 < width) buf[i + width + 1] += err / 16;
      }
    }
  }
  return out;
}

// RGBA → RGBA أبيض/أسود. options: { mode: 'threshold' | 'dither', invert, width }
// width مطلوب للتنقيط. صورة بلون واحد: فاتحة = بيضاء، داكنة = سوداء (في النمطين)
function toMonochrome(rgba, options = {}) {
  const { mode = 'threshold', invert = false, width } = options;
  const gray = toGrayscale(rgba);
  const min = gray.reduce((a, b) => Math.min(a, b), 255);
  const max = gray.reduce((a, b) => Math.max(a, b), 0);
  const uniform = max === min;
  let bw;
  let threshold = null;
  if (uniform) {
    bw = new Uint8Array(gray.length).fill(max > 127 ? 255 : 0);
  } else if (mode === 'dither') {
    if (!width) throw new Error('width مطلوب للتنقيط');
    bw = ditherFloydSteinberg(stretchLevels(gray, min, max), width);
  } else {
    threshold = otsuThreshold(gray);
    bw = gray.map((g) => (g <= threshold ? 0 : 255));
  }
  const out = new Uint8ClampedArray(rgba.length);
  for (let p = 0; p < bw.length; p++) {
    const v = invert ? 255 - bw[p] : bw[p];
    out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = v;
    out[p * 4 + 3] = 255;
  }
  return { data: out, threshold };
}

const fail = (reason) => ({ ok: false, reason });

const MODES = ['threshold', 'dither'];
const normalize = (options = {}) => ({
  mode: MODES.includes(options.mode) ? options.mode : 'threshold',
  invert: options.invert === true,
});

// يحمّل صورة من رابط (blob: أو data:) ويحرّر الرابط المؤقت لو طلب المستدعي
function loadImage(url, ImageCtor) {
  const img = new ImageCtor();
  return new Promise((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode'));
    img.src = url;
  });
}

// يرسم الصورة على canvas بخلفية بيضاء وبالحجم المناسب، ويرجع أيضًا نسخة رمادية صغيرة (JPEG)
// تُحفظ لإعادة المعالجة (تغيير النمط/العكس) بدون إعادة رفع الصورة الأصلية
function renderLogo(img, doc, options, wantSource) {
  const { w, h } = fitSize(img.naturalWidth || LOGO_MAX_W, img.naturalHeight || Math.round(LOGO_MAX_W / 2));
  const canvas = doc.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);

  let srcUrl = '';
  if (wantSource) {
    const gray = toGrayscale(image.data);
    for (let p = 0; p < gray.length; p++) {
      image.data[p * 4] = image.data[p * 4 + 1] = image.data[p * 4 + 2] = gray[p];
      image.data[p * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    srcUrl = canvas.toDataURL('image/jpeg', 0.85);
  }

  image.data.set(toMonochrome(image.data, { ...options, width: w }).data);
  ctx.putImageData(image, 0, 0);
  const dataUrl = canvas.toDataURL('image/png');
  if (dataUrl.length > MAX_OUTPUT_CHARS) return fail('too-large-output');
  return { ok: true, dataUrl, srcUrl, width: w, height: h };
}

// يقرأ ملف صورة ويرجع { ok, dataUrl, srcUrl, width, height } (PNG أبيض/أسود + نسخة رمادية) أو { ok:false, reason }
// reason: not-image | too-big | decode | too-large-output
async function processLogoFile(file, options = {}, env = {}) {
  if (!file || !/^image\//.test(file.type || '')) return fail('not-image');
  if (file.size > MAX_FILE_BYTES) return fail('too-big');
  const doc = env.document || document;
  const urls = env.URL || URL;
  const ImageCtor = env.Image || Image;

  const url = urls.createObjectURL(file);
  try {
    const img = await loadImage(url, ImageCtor);
    return renderLogo(img, doc, normalize(options), true);
  } catch {
    return fail('decode');
  } finally {
    urls.revokeObjectURL(url);
  }
}

// يعيد المعالجة من النسخة الرمادية المحفوظة (srcUrl من processLogoFile) بنمط/عكس مختلف
async function reprocessLogo(srcUrl, options = {}, env = {}) {
  if (typeof srcUrl !== 'string' || !/^data:image\/jpeg;base64,/.test(srcUrl)) return fail('not-image');
  const doc = env.document || document;
  const ImageCtor = env.Image || Image;
  try {
    const img = await loadImage(srcUrl, ImageCtor);
    const result = renderLogo(img, doc, normalize(options), false);
    return result.ok ? { ...result, srcUrl } : result;
  } catch {
    return fail('decode');
  }
}

function logoMessage(reason) {
  switch (reason) {
    case 'not-image':
      return 'اختر ملف صورة (PNG أو JPG أو SVG)';
    case 'too-big':
      return 'الصورة كبيرة جدًا (الحد 5 ميجا)';
    case 'too-large-output':
      return 'الشعار معقّد جدًا — جرّب صورة أبسط';
    default:
      return 'تعذّر قراءة الصورة';
  }
}

module.exports = {
  LOGO_MAX_W,
  LOGO_MAX_H,
  fitSize,
  toGrayscale,
  otsuThreshold,
  ditherFloydSteinberg,
  toMonochrome,
  processLogoFile,
  reprocessLogo,
  logoMessage,
};
