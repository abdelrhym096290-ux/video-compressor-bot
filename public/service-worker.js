  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  // ⭐ لا نتدخل إطلاقاً في POST (كل استدعاءات API) — شبكة مباشرة دائماً
  if (request.method !== 'GET') return;

  // ⭐ لأيقونات/manifest الثابتة فقط: شبكة أولاً، ثم كاش كخط رجوع عند انقطاع الاتصال
  const url = new URL(request.url);
  if (SHELL_ASSETS.some(p => url.pathname === p)) {
    event.respondWith(
      fetch(request).then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone)).catch(() => {});
        return res;
      }).catch(() => caches.match(request))
    );
    return;
  }
  // كل شيء آخر (الصفحة الرئيسية، أي مسار API): شبكة مباشرة بلا أي تخزين مؤقت
});
