const C='wa2p-v1.14.0';const A=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-maskable-512.png'];
// المشاركة من واتساب: نفس الاسم والمفتاح في src/share.js (SHARE_CACHE / SHARE_KEY)
const SHARE='wa2p-share',KEY='payload';
async function handleShare(q){try{const f=await q.formData();const t=[f.get('text'),f.get('url'),f.get('title')].map(x=>x?String(x).trim():'').find(Boolean)||'';if(t){const c=await caches.open(SHARE);await c.put(KEY,new Response(t))}}catch(_){}return Response.redirect(new URL('./?share=1',self.registration.scope).href,303)}
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C&&x!==SHARE).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{if(e.request.method==='POST'&&new URL(e.request.url).pathname.endsWith('/share-target')){e.respondWith(handleShare(e.request));return}if(e.request.method!=='GET')return;e.respondWith(fetch(e.request).then(r=>{if(r.ok&&new URL(e.request.url).origin===location.origin){const c=r.clone();caches.open(C).then(x=>x.put(e.request,c))}return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('index.html'))))});
