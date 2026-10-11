// 野外取样工具 Service Worker — 页面本体+静态文件离线可用
// v5：修复单文件下载失败导致整个安装失败的问题；任意同域导航离线回退到主页面
const CACHE = "sampling-v5";
const BASE = new URL(self.registration.scope).pathname; // /ecobox-sampling/
const BASE_ROOT = BASE.endsWith("/") ? BASE.slice(0, -1) : BASE;
const MAIN_PAGE = BASE + "sampling_helper.html";
const PAGES = [MAIN_PAGE, BASE + "index.html", BASE + "clear.html"];
const STATIC = [BASE + "manifest.json", BASE + "icon.svg", BASE + "geo_1230se.jpg"];

async function tryCache(c, f) {
  try {
    const r = await fetch(new Request(f, { cache: "no-store" }));
    if (r.ok) await c.put(f, r);
    return true;
  } catch (e) {
    return false; // 单个文件失败不阻塞安装（关键改动）
  }
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 页面逐个缓存：一个失败不影响其余，更不影响安装本身
    for (const f of PAGES) await tryCache(c, f);
    // 静态大文件后台补缓存，绝不阻塞安装完成
    Promise.all(STATIC.map((f) => tryCache(c, f)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;

  const isPage = PAGES.includes(u.pathname);
  const isStatic = STATIC.includes(u.pathname);
  // 任意同域导航请求都算页面（覆盖裸目录、奇怪参数等入口）
  const isNav = e.request.mode === "navigate" &&
    (u.pathname === BASE_ROOT || u.pathname.startsWith(BASE));
  if (!isPage && !isNav && !isStatic) return;

  e.respondWith((async () => {
    const cacheKey = isPage || isStatic ? u.pathname : MAIN_PAGE;
    const cachedHit = (await caches.match(cacheKey)) || (await caches.match(MAIN_PAGE));

    // 静态资源：缓存优先，联网成功顺手补缓存（懒修复安装期失败文件）
    if (isStatic && !isNav) {
      if (cachedHit) return cachedHit;
      try {
        const r = await fetch(e.request);
        if (r.ok) {
          const c = await caches.open(CACHE);
          c.put(u.pathname, r.clone());
        }
        return r;
      } catch (err) {
        return new Response("", { status: 404 });
      }
    }

    // 页面/导航：网络优先（8s 超时），失败回退缓存主页面——离线必能打开
    try {
      const r = await Promise.race([
        fetch(e.request, { cache: "no-store" }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
      ]);
      if (r.ok) {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(MAIN_PAGE, copy));
        return r;
      }
    } catch (err) { /* 离线或超时 → 走缓存 */ }
    if (cachedHit) return cachedHit;
    return new Response("离线且页面未缓存：请联网打开一次后再试", {
      status: 503,
      headers: { "Content-Type": "text/plain;charset=utf-8" },
    });
  })());
});
