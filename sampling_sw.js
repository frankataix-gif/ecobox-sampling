// 野外取样工具 Service Worker — 缓存页面本体、manifest 和图标，离线可打开
const CACHE = "sampling-v2";
const BASE = new URL(self.registration.scope).pathname;
const FILES = [BASE + "sampling_helper.html", BASE + "manifest.json", BASE + "icon.svg"];

self.addEventListener("install", (e) => {
  // 安装时绕过浏览器 HTTP 缓存，确保拿到最新版本
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "no-store" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  // 只处理本工具页面、manifest、图标：网络优先，失败回缓存
  if (u.origin === location.origin && (u.pathname === FILES[0] || u.pathname === FILES[1] || u.pathname === FILES[2])) {
    const isPage = u.pathname === FILES[0];
    e.respondWith(
      fetch(e.request, isPage ? { cache: "no-store" } : {})
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return r;
        })
        .catch(() => caches.match(e.request))
    );
  }
});
