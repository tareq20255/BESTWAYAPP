'use strict';
// شعار الإيصال: تحويل أي صورة إلى أبيض وأسود مناسب للطابعة الحرارية بحجم صغير.
// الدوال النقية (fitSize / toGrayscale / otsuThreshold / toMonochrome) تُختبر في Node؛
// processLogoFile يحتاج المتصفح (canvas) ويُمرَّر له env للاختبار عند الحاجة.

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

// RGBA → RGBA أبيض/أسود. صورة بلون واحد: فاتحة = بيضاء، داكنة = سوداء
function toMonochrome(rgba) {
  const gray = toGrayscale(rgba);
  const min = gray.reduce((a, b) => Math.min(a, b), 255);
  const max = gray.reduce((a, b) => Math.max(a, b), 0);
  const threshold = max === min ? (max > 127 ? -1 : 255) : otsuThreshold(gray);
  const out = new Uint8ClampedArray(rgba.length);
  for (let p = 0; p < gray.length; p++) {
    const v = gray[p] <= threshold ? 0 : 255;
    out[p * 4] = out[p * 4 + 1] = out[p * 4 + 2] = v;
    out[p * 4 + 3] = 255;
  }
  return { data: out, threshold };
}

const fail = (reason) => ({ ok: false, reason });

// يقرأ ملف صورة ويرجع { ok, dataUrl, width, height } (PNG أبيض/أسود) أو { ok:false, reason }
// reason: not-image | too-big | decode | too-large-output
async function processLogoFile(file, env = {}) {
  if (!file || !/^image\//.test(file.type || '')) return fail('not-image');
  if (file.size > MAX_FILE_BYTES) return fail('too-big');
  const doc = env.document || document;
  const urls = env.URL || URL;
  const ImageCtor = env.Image || Image;

  const url = urls.createObjectURL(file);
  try {
    const img = new ImageCtor();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('decode'));
      img.src = url;
    });
    const sourceW = img.naturalWidth || LOGO_MAX_W;
    const sourceH = img.naturalHeight || Math.round(LOGO_MAX_W / 2);
    const { w, h } = fitSize(sourceW, sourceH);
    const canvas = doc.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const image = ctx.getImageData(0, 0, w, h);
    image.data.set(toMonochrome(image.data).data);
    ctx.putImageData(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/png');
    if (dataUrl.length > MAX_OUTPUT_CHARS) return fail('too-large-output');
    return { ok: true, dataUrl, width: w, height: h };
  } catch {
    return fail('decode');
  } finally {
    urls.revokeObjectURL(url);
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
  toMonochrome,
  processLogoFile,
  logoMessage,
};
