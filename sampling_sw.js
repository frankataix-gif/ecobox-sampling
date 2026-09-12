// 野外取样工具 Service Worker — 缓存页面本体、manifest 和图标，离线可打开
const CACHE = "sampling-v3";
const BASE = new URL(self.registration.scope).pathname;
const PAGES = [BASE + "sampling_helper.html", BASE + "index.html", BASE + "clear.html"];
const STATIC = [BASE + "manifest.json", BASE + "icon.svg"];
const ALL = [...PAGES, ...STATIC];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ALL.map((f) => new Request(f, { cache: "no-store" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;

  // HTML 页面：网络优先，离线回退缓存（忽略 ?r= 参数）
  if (PAGES.includes(u.pathname)) {
    e.respondWith(
      fetch(e.request, { cache: "no-store" })
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(u.pathname, copy));
          }
          return r;
        })
        .catch(() => caches.match(u.pathname))
    );
    return;
  }

  // 静态资源：缓存优先，失败再联网
  if (STATIC.includes(u.pathname)) {
    e.respondWith(
      caches.match(u.pathname).then((res) => res || fetch(e.request).then((r) => {
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(u.pathname, copy));
        }
        return r;
      }))
    );
  }
});
