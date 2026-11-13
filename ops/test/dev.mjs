/* 本地调试页面的小服务器：真 Worker + 内存 D1，页面注入错误横幅，方便用浏览器复现。
 * 用法：node ops/test/dev.mjs  然后打开 http://127.0.0.1:8899
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8");
let page = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace("__BUILD__", "dev");
page = page.replace("</body>", `<script>
window.__ERRS = [];
function __banner(t) {
  let d = document.getElementById("__err");
  if (!d) { d = document.createElement("pre"); d.id = "__err"; d.style.cssText = "position:fixed;left:0;right:0;bottom:0;max-height:45%;overflow:auto;background:#fee;color:#900;font:12px/1.4 monospace;padding:8px;z-index:99999;white-space:pre-wrap;border-top:2px solid #c00"; document.body.appendChild(d); }
  d.textContent += t + "\\n";
}
window.onerror = (m, s, l, c, e) => { window.__ERRS.push(String(m)); __banner("ERROR: " + m + " @" + l + ":" + c + (e && e.stack ? "\\n" + e.stack : "")); };
window.addEventListener("unhandledrejection", (e) => { const r = e.reason; window.__ERRS.push(String(r && r.message || r)); __banner("REJECT: " + (r && r.message || r) + (r && r.stack ? "\\n" + r.stack : "")); });
</script></body>`);
globalThis.__OPS_PAGE__ = page;

class Stmt {
  constructor(db, sql, args) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
  }
}
class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new Stmt(this.db, sql, []); }
}
const db = new DatabaseSync(":memory:");
db.exec(schema);
const { default: worker } = await import(pathToFileURL(path.join(ROOT, "worker.js")).href);

const R2 = new Map();
const PHOTOS = {
  async put(key, bytes, opts = {}) { R2.set(key, { bytes, mime: (opts.httpMetadata && opts.httpMetadata.contentType) || "" }); return { key }; },
  async get(key) { const o = R2.get(key); return o ? { body: o.bytes, httpMetadata: { contentType: o.mime } } : null; },
  async head(key) { return R2.has(key) ? { key } : null; },
  async delete(key) { R2.delete(key); },
  async list() { return { objects: [] }; },
};
const env = { DB: new D1(db), SETUP_TOKEN: "setup-dev", FIN_OWNER: "boss@ecobox.com", PHOTOS };

const PORT = Number(process.env.PORT || 8899);
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = "http://127.0.0.1:" + PORT + req.url;
  const r = await worker.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env, {});
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(await r.text());
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));

const BASE = "http://127.0.0.1:" + PORT;
const call = async (p, o = {}) => {
  const r = await fetch(BASE + p, {
    method: o.method || "POST",
    headers: { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers || {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
};

const today = new Date().toISOString().slice(0, 10);
await call("/api/setup", { body: { login: "boss@ecobox.com", name: "老板", password: "ecobox2026" }, headers: { "x-setup-token": "setup-dev" } });
const boss = await call("/api/login", { body: { login: "boss@ecobox.com", password: "ecobox2026" } });
const mk = (login, name, role) => call("/api/users", { cookie: boss.cookie, body: { login, name, password: "pass2026x", role } });
await mk("mgr@ecobox.com", "负责人", "manager");
await mk("fin@ecobox.com", "财务", "finance");
await mk("staff@ecobox.com", "员工", "staff");
const add = (uid, body) => call("/api/fin/entries", { cookie: boss.cookie, body: { uid, date: today, ch: "cash", cat: "misc", ft: "life", amount: 10, note: "调试用", ...body } });
await add("boss@ecobox.com", { kind: "out" });
await add("__company", { kind: "out", ch: "card", amount: 88 });
await add("boss@ecobox.com", { kind: "transfer", to_uid: "staff@ecobox.com", to_ch: "cash", amount: 50 });
await add("boss@ecobox.com", { kind: "float", to_uid: "staff@ecobox.com", amount: 30 });

console.log("DEV READY " + BASE);
console.log("BOSS_COOKIE " + boss.cookie);
