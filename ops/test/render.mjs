/* 页面渲染冒烟：真 Worker（内存 D1）+ jsdom 打开页面，把每个页签和记账弹层都点一遍。
 * 需要先装 jsdom（不进依赖，缺了就 SKIP）：npm i jsdom
 * 用法：node ops/test/render.mjs [boss|mgr|fin|staff]
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

let jsdom;
try { jsdom = await import("jsdom"); }
catch { console.log("SKIP 没装 jsdom：npm i jsdom 后再跑"); process.exit(0); }
const { JSDOM, CookieJar, VirtualConsole } = jsdom;

const ROOT = process.env.OPS_ROOT ? path.resolve(process.env.OPS_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8");
const role = process.argv[2] || "boss";

globalThis.__OPS_PAGE__ = fs.readFileSync(path.join(ROOT, "index.html"), "utf8").replace("__BUILD__", "dev");

class Stmt {
  constructor(db, sql, args) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; }
}
class D1 { constructor(db) { this.db = db; } prepare(sql) { return new Stmt(this.db, sql, []); } }

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

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request("http://127.0.0.1:" + server.address().port + req.url, { method: req.method, headers: req.headers, body }), env, {});
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(await r.text());
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const BASE = "http://127.0.0.1:" + server.address().port;

const call = async (p, o = {}) => {
  const r = await fetch(BASE + p, {
    method: o.method || "POST",
    headers: { "content-type": "application/json", ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers || {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
};

const today = new Date().toISOString().slice(0, 10);
await call("/api/setup", { body: { login: "boss@ecobox.com", name: "老板", password: "ecobox2026" }, headers: { "x-setup-token": "setup-dev" } });
const boss = await call("/api/login", { body: { login: "boss@ecobox.com", password: "ecobox2026" } });
const mk = (login, name, r) => call("/api/users", { cookie: boss.cookie, body: { login, name, password: "pass2026x", role: r } });
await mk("mgr@ecobox.com", "负责人", "manager");
await mk("fin@ecobox.com", "财务", "finance");
await mk("staff@ecobox.com", "员工", "staff");
const add = (uid, body) => call("/api/fin/entries", { cookie: boss.cookie, body: { uid, date: today, ch: "cash", cat: "misc", ft: "life", amount: 10, note: "调试用", ...body } });
await add("boss@ecobox.com", { kind: "out" });
await add("__company", { kind: "out", ch: "card", amount: 88 });
await add("boss@ecobox.com", { kind: "transfer", to_uid: "staff@ecobox.com", to_ch: "cash", amount: 50 });
await add("boss@ecobox.com", { kind: "float", to_uid: "staff@ecobox.com", amount: 30 });
await call("/api/fin/accounts/boss@ecobox.com", { method: "PUT", cookie: boss.cookie, body: { name: "老板", cash: 100, card: 500, since: today } });

const login = role === "boss" ? boss : await call("/api/login", { body: { login: role + "@ecobox.com", password: "pass2026x" } });
const jar = new CookieJar();
await jar.setCookie(login.cookie + "; Path=/", BASE);
const vc = new VirtualConsole();
const problems = [];
vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) problems.push("JSDOMERR " + e.message); });

const dom = await JSDOM.fromURL(BASE + "/", {
  runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc, cookieJar: jar,
  beforeParse(w) {
    w.fetch = (u, o = {}) => fetch(new URL(u, BASE), { ...o, headers: { ...(o.headers || {}), cookie: login.cookie } });
    w.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
    w.confirm = () => true; w.alert = () => {}; w.prompt = () => ""; w.scrollTo = () => {};
  },
});
await new Promise((r) => dom.window.addEventListener("load", r));
await new Promise((r) => setTimeout(r, 1200));
const w = dom.window;

const tabs = ["home", "status", "mine", "fin", "log", "company", "users", "lang", "todo", "bank", "punch", "export", "customer", "g:财务", "g:日常协同", "g:业务现场", "g:资产", "g:系统"];
for (const t of tabs) {
  const out = await w.eval(`(async () => {
    try {
      S.tab = ${JSON.stringify(t)}; S.fresh = true; FINWHO = "";
      await render();
      await new Promise((r) => setTimeout(r, 400));
      const p = document.getElementById("pane");
      const txt = p.textContent.trim();
      if (txt.startsWith("这个页面打不开")) return "ERR " + txt.slice(0, 160);
      if (txt === "加载中…" || txt === "") return "STUCK";
      return "ok";
    } catch (e) { return "THROW " + e.message; }
  })()`);
  console.log((out === "ok" ? "  ok   " : "  FAIL ") + t.padEnd(12) + (out === "ok" ? "" : out));
  if (out !== "ok") problems.push(t + " " + out);
}

await w.eval(`(async () => { S.tab = "fin"; await render(); await new Promise((r) => setTimeout(r, 300)); })()`);
const sheets = [
  ["add", "finSheet()"],
  ["transfer", "finTransferSheet()"],
  ["move", "finMoveSheet()"],
  ["cosend", "FIN.canCo ? finTransferSheet(null, FINCO) : 0"],
];
for (const [name, code] of sheets) {
  const out = await w.eval(`(async () => {
    try {
      ${code};
      await new Promise((r) => setTimeout(r, 200));
      document.querySelectorAll(".fin-dim").forEach((x) => x.remove());
      return "ok";
    } catch (e) { return "THROW " + e.message; }
  })()`);
  console.log((out === "ok" ? "  ok   " : "  FAIL ") + name.padEnd(12) + (out === "ok" ? "" : out));
  if (out !== "ok") problems.push(name + " " + out);
}

console.log(problems.length ? "FAILED " + problems.length : "OK 页面渲染全通(" + role + ")");
server.close();
process.exit(problems.length ? 1 : 0);
