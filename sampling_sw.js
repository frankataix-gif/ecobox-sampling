// 野外取样工具 Service Worker
// 唯一目标：**页面本体一定要留在本机**，断网冷启动（关掉再打开）必须能进。
// 做法：安装时抓一份页面并校验内容后写进 sampling-shell（activate 不清它），
// 导航请求缓存优先（不等网络），新缓存没拿到页面之前绝不删除旧缓存。
const CACHE = "sampling-v59";
const SHELL_CACHE = "sampling-shell"; // 只放校验过的页面本体
const BASE = new URL(self.registration.scope).pathname; // /ecobox-sampling/
const BASE_ROOT = BASE.endsWith("/") ? BASE.slice(0, -1) : BASE;
const MAIN_PAGE = BASE + "sampling_helper.html";
const PAGES = [MAIN_PAGE, BASE + "licences.html", BASE + "index.html", BASE + "clear.html"];
const STATIC = [BASE + "manifest.json", BASE + "icon.svg", BASE + "icon-192.png", BASE + "icon-512.png",
  BASE + "icon-maskable-512.png", BASE + "apple-touch-icon.png", BASE + "geo_1230se.jpg"];
// 矿区配置：网络优先，离线回退缓存（改配置刷新即生效，不必等新版本）
const CONFIG = [BASE + "areas.json", BASE + "licences.json"];
const SHELL_MARKS = ['id="pg-form"', 'id="pg-list"', 'id="list_stat"'];
const abs = (p) => new URL(p, self.location.origin).href;

async function tryCache(c, f) {
  try {
    const r = await fetch(new Request(abs(f), { cache: "no-store" }));
    if (r.ok) await c.put(abs(f), r);
    return true;
  } catch (e) {
    return false; // 单个文件失败不阻塞安装
  }
}

const looksLikeShell = (t) => !!t && SHELL_MARKS.every((m) => t.includes(m));

async function fetchShell() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(abs(MAIN_PAGE) + "?_sw=" + Date.now(), { cache: "no-store" });
      if (r.ok) {
        const t = await r.text();
        // 只认自己的页面：热点登录页 / 运营商劫持页不能写进缓存
        if (looksLikeShell(t)) return t;
      }
    } catch (e) { /* 离线/抖动 → 重试 */ }
    await new Promise((s) => setTimeout(s, 600 * (i + 1)));
  }
  return null;
}

async function putShell(c, text) {
  const mk = () => new Response(text, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "X-Cached-At": String(Date.now()),
    },
  });
  // 主页面 + 裸目录（/ecobox-sampling/）都存一份，任何入口都能打开
  for (const key of [MAIN_PAGE, BASE]) await c.put(abs(key), mk());
}

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const f of PAGES) await tryCache(c, f);
    const t = await fetchShell();
    if (!t) throw new Error("shell-cache-failed"); // 页面没抓到就别激活，旧缓存继续顶着
    await putShell(c, t);
    await putShell(await caches.open(SHELL_CACHE), t);
    Promise.all(STATIC.concat(CONFIG).map((f) => tryCache(c, f))); // 大文件后台补
    await self.skipWaiting();
  })());
});

self.addEventListener("message", (e) => {
  const d = e.data;
  if (d === "SKIP_WAITING") self.skipWaiting();
  if (d === "CACHE_ALL") {
    e.waitUntil((async () => {
      const c = await caches.open(CACHE);
      for (const f of PAGES) await tryCache(c, f);
      const t = await fetchShell();
      if (t) {
        await putShell(c, t);
        await putShell(await caches.open(SHELL_CACHE), t);
      }
      await Promise.all(STATIC.concat(CONFIG).map((f) => tryCache(c, f)));
      const hit = await caches.match(abs(MAIN_PAGE), { ignoreSearch: true });
      const size = hit ? (await hit.clone().text()).length : 0;
      if (e.source && e.source.postMessage) e.source.postMessage({ type: "CACHE_ALL_DONE", ok: size > 20000, bytes: size });
    })());
  }
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    // 只清本应用的旧版本缓存；sampling-shell 留着（那是离线保命的那份）
    await Promise.all(ks.filter((k) => /^sampling-v\d+$/.test(k) && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

async function readCachedShell() {
  // 先用当前版本缓存（最新），再用 sampling-shell 兜底（保命）
  for (const name of [CACHE, SHELL_CACHE]) {
    try {
      const c = await caches.open(name);
      const hit = (await c.match(abs(MAIN_PAGE), { ignoreSearch: true })) ||
                  (await c.match(abs(BASE), { ignoreSearch: true }));
      if (hit) return hit;
    } catch (e) { /* 缓存被清 → 试下一个 */ }
  }
  return null;
}

let refreshing = false, lastRefresh = 0;
const verOf = (t) => ((t || "").match(/const APP_VER="([^"]+)"/) || [])[1] || "";
async function refreshShell() {
  const t = await fetchShell();
  if (!t) return;
  const old = await readCachedShell().catch(() => null);
  const oldText = old ? await old.clone().text().catch(() => "") : "";
  await putShell(await caches.open(CACHE), t);
  await putShell(await caches.open(SHELL_CACHE), t);
  // 第二道保险：SW 自己发现页面变新了就喊前台弹更新条（version.txt 探针失效时也能提醒）
  const nv = verOf(t), ov = verOf(oldText);
  if (nv && nv !== ov) {
    const cs = await self.clients.matchAll({ includeUncontrolled: true });
    cs.forEach((c) => c.postMessage({ type: "NEW_VER", ver: nv }));
  }
}

const OFFLINE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>离线缓存未就绪</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f4f6f9;color:#1e293b;margin:0;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}
.b{background:#fff;border-radius:14px;padding:26px 22px;max-width:340px;box-shadow:0 2px 10px rgba(0,0,0,.08)}
h1{font-size:18px;margin:0 0 10px}p{font-size:14px;color:#64748b;line-height:1.7;margin:0 0 18px}
button{border:none;border-radius:10px;padding:13px 22px;font-size:15px;background:#1668dc;color:#fff;width:100%}</style>
</head><body><div class="b"><h1>还没存好离线副本</h1>
<p>这台手机还没有下载到页面本体，所以现在断网打不开。<br>请连上网络（手机流量也行）打开一次，等页面正常显示后停留 30 秒，再断网就一定能打开。</p>
<button onclick="location.reload()">重新加载</button></div></body></html>`;

const PAGE_OFFLINE_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>这一页还没存到本机</title>
<style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f4f6f9;color:#1e293b;margin:0;
display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;text-align:center}
.b{background:#fff;border-radius:14px;padding:26px 22px;max-width:340px;box-shadow:0 2px 10px rgba(0,0,0,.08)}
h1{font-size:18px;margin:0 0 10px}p{font-size:14px;color:#64748b;line-height:1.7;margin:0 0 18px}
a{display:block;border-radius:10px;padding:13px 22px;font-size:15px;background:#1668dc;color:#fff;text-decoration:none}</style>
</head><body><div class="b"><h1>这一页还没存到本机</h1>
<p>现在没网，这个页面之前也没打开过，所以打不开。<br>联网打开一次之后，断网也能进来。</p>
<a href="sampling_helper.html">先回记录本</a></div></body></html>`;

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin || e.request.method !== "GET") return;

  const isPage = PAGES.includes(u.pathname);
  const isStatic = STATIC.includes(u.pathname);
  const isCfg = CONFIG.includes(u.pathname);
  const isGeo = u.pathname.startsWith(BASE + "geo/");
  const isNav = e.request.mode === "navigate" && (u.pathname === BASE_ROOT || u.pathname.startsWith(BASE));

  if (isGeo) {
    e.respondWith((async () => {
      const hit = await caches.match(u.pathname);
      const net = fetch(e.request).then((r) => {
        if (r.ok) caches.open(CACHE).then((c) => c.put(u.pathname, r.clone()));
        return r;
      }).catch(() => null);
      if (hit) { net; return hit; }
      const r = await net;
      return r || new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
    })());
    return;
  }
  if (!isPage && !isNav && !isStatic && !isCfg) return;

  // 矿区配置：网络优先，离线回退缓存
  if (isCfg) {
    e.respondWith((async () => {
      try {
        const r = await fetch(e.request, { cache: "no-store" });
        if (r.ok) {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(u.pathname, copy));
          return r;
        }
      } catch (err) { /* 离线 → 走缓存 */ }
      const hit = await caches.match(u.pathname);
      if (hit) return hit;
      return new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } });
    })());
    return;
  }

  // 静态资源：缓存优先，联网成功顺手补缓存
  if (isStatic && !isNav) {
    e.respondWith((async () => {
      const hit = await caches.match(u.pathname);
      if (hit) return hit;
      try {
        const r = await fetch(e.request);
        if (r.ok) caches.open(CACHE).then((c) => c.put(u.pathname, r.clone()));
        return r;
      } catch (err) {
        return new Response("", { status: 404 });
      }
    })());
    return;
  }

  // 其它内页（矿证资料、清空页…）：各自独立缓存，网络优先，离线回退自己那份
  const isShellPath = u.pathname === MAIN_PAGE || u.pathname === BASE || u.pathname === BASE_ROOT;
  if (isPage && !isShellPath) {
    e.respondWith((async () => {
      try {
        const r = await fetch(e.request, { cache: "no-store" });
        if (r.ok) caches.open(CACHE).then((c) => c.put(abs(u.pathname), r.clone()));
        return r;
      } catch (err) { /* 离线 → 走这一页自己的缓存 */ }
      const hit = await caches.match(abs(u.pathname), { ignoreSearch: true });
      if (hit) return hit;
      return new Response(PAGE_OFFLINE_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    })());
    return;
  }

  // 主页面/裸目录/其它导航：缓存优先（断网秒开），后台悄悄刷新，刷新时校验内容不被劫持
  if (!refreshing && Date.now() - lastRefresh > 30000) {
    refreshing = true;
    lastRefresh = Date.now();
    e.waitUntil(refreshShell().catch(() => {}).finally(() => { refreshing = false; }));
  }
  e.respondWith((async () => {
    const hit = await readCachedShell();
    if (hit) return hit;
    try {
      const r = await fetch(e.request);
      if (r.ok) return r;
    } catch (err) { /* 没网也没缓存 */ }
    return new Response(OFFLINE_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  })());
});
