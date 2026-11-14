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
/* 大额：验证列表里是 1,234,567.89 这种财务格式，不是裸数字 */
await add("boss@ecobox.com", { kind: "out", amount: 1234567.89, note: "财务格式" });
await call("/api/fin/accounts/boss@ecobox.com", { method: "PUT", cookie: boss.cookie, body: { name: "老板", cash: 100, card: 500, since: today } });
/* 公司账户 / 员工各先登记一张卡：银行账单 / 原始单据都只能从登记的卡里选 */
await call("/api/fin/accounts/__company", { method: "PUT", cookie: boss.cookie, body: { name: "公司账户", cash: 0, card: 9000, since: today, banks: [{ bank: "IZB", no: "0391020000704", ccy: "ZMW", bal: 9000 }] } });
await call("/api/fin/accounts/staff@ecobox.com", { method: "PUT", cookie: boss.cookie, body: { name: "员工", cash: 0, card: 0, since: today, banks: [{ bank: "Zanaco", no: "555000222", ccy: "ZMW" }] } });

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

/* 顶部只留 目录 / 动态 / 系统；打开就停在目录 */
const nav = await w.eval(`(async () => {
  const btns = [...document.querySelectorAll("#tabs [data-tab]")];
  const keys = btns.map((b) => b.dataset.tab).join(",");
  if (keys !== "home,status,g:系统") return "keys=" + keys;
  const on = btns.filter((b) => b.classList.contains("on")).map((b) => b.dataset.tab).join(",");
  if (on !== "home") return "active=" + on;
  if (S.tab !== "home") return "tab=" + S.tab;
  const secs = [...document.querySelectorAll("#pane .sec")].map((x) => x.textContent.trim());
  if (!secs.some((t) => t === tr("系统") || t === "系统")) return "no system group: " + secs.join("|");
  return "ok";
})()`);
console.log((nav === "ok" ? "  ok   " : "  FAIL ") + "topnav".padEnd(12) + (nav === "ok" ? "" : nav));
if (nav !== "ok") problems.push("topnav " + nav);

/* 点「系统」：内容进系统组，顶部高亮也应该是「系统」而不是「目录」 */
const grp = await w.eval(`(async () => {
  const b = [...document.querySelectorAll("#tabs [data-tab]")].find((x) => x.dataset.tab === "g:系统");
  if (!b) return "no tab";
  b.click();
  await new Promise((r) => setTimeout(r, 400));
  const on = [...document.querySelectorAll("#tabs [data-tab].on")].map((x) => x.dataset.tab).join(",");
  if (on !== "g:系统") return "on=" + on;
  if (S.tab !== "g:系统") return "tab=" + S.tab;
  if (!/系统/.test(document.getElementById("pane").textContent || "")) return "pane";
  return "ok";
})()`);
console.log((grp === "ok" ? "  ok   " : "  FAIL ") + "grouptab".padEnd(12) + (grp === "ok" ? "" : grp));
if (grp !== "ok") problems.push("grouptab " + grp);

const tabs = ["home", "status", "mine", "fin", "log", "company", "users", "lang", "todo", "bank", "bankdoc", "punch", "export", "customer", "finacct", "g:财务", "g:日常协同", "g:业务现场", "g:资产", "g:系统"];
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
  ["bankdoc", "finBankDocSheet()"],
  ["bankcard", "finBankCardSheet(FINCO, null)"],
  ["banksheet", "finBankSheet()"],
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

/* 费用记录：现金 / 银行分开看；银行按卡一块，卡头带期初 / 账面 / 账单期末 */
const book = await w.eval(`(async () => {
  let out = "ok";
  try {
    S.tab = "fin";
    /* 银行账按卡排：先切到能看到卡的范围（公司账户 / 全部 / 自己） */
    if (FIN.canCo) FINWHO = "__company"; else if (FIN.canAll) FINWHO = "ALL";
    FINCH = "bank"; await render(); await new Promise((r) => setTimeout(r, 200));
    const tabs = !!document.querySelector('[data-finch="cash"]') && !!document.querySelector('[data-finch="bank"]');
    if (!tabs) out = "没有现金/银行页签";
    else {
      /* 自己名下没卡、又看不到别人的账，就只验页签 */
      const wantCard = ((FINVIEW && FINVIEW.list) || []).some((e) => (e.acct === "bank" || e.ch === "card"));
      const card = document.querySelector("[data-finbook]");
      if (wantCard && !card) out = "银行账没有按卡分块";
      else if (card && !/期初/.test(card.textContent || "")) out = "卡头缺期初：" + (card.textContent || "").slice(0, 60);
    }
  } catch (e) { out = "THROW " + e.message; }
  FINCH = "cash"; FINWHO = "";
  try { await render(); await new Promise((r) => setTimeout(r, 150)); } catch (e) {}
  if (out === "ok" && document.querySelector("[data-finbook]")) out = "切回现金还显示卡块";
  return out;
})()`);
console.log((book === "ok" ? "  ok   " : "  FAIL ") + "finbook".padEnd(12) + (book === "ok" ? "" : book));
if (book !== "ok") problems.push("finbook " + book);

/* 记账表单：选「银行」必须出现卡下拉，且能选到已登记的卡 */
const fcard = await w.eval(`(async () => {
  try {
    S.tab = "fin"; await render();
    finSheet();
    const ch = document.getElementById("ff_ch");
    if (!ch) return "没有渠道选择";
    ch.value = "card"; ch.onchange && ch.onchange();
    const wrap = document.getElementById("ff_cardwrap");
    const sel = document.getElementById("ff_card");
    if (!wrap || !sel) return "没有卡下拉";
    if (wrap.classList.contains("hide")) return "选银行后卡下拉没出现";
    const uid = document.getElementById("ff_uid");
    let opt = sel.options[0] ? sel.options[0].textContent : "";
    if (uid) { uid.value = "__company"; uid.onchange && uid.onchange(); opt = sel.options[0] ? sel.options[0].textContent : ""; }
    document.querySelectorAll(".fin-dim").forEach((x) => x.remove());
    if (!sel.options.length) return "卡下拉没有选项";
    if (uid && !/IZB|…|银行/.test(opt)) return "公司账户的卡没列出来：" + opt;
    return "ok";
  } catch (e) { return "THROW " + e.message; }
})()`);
console.log((fcard === "ok" ? "  ok   " : "  FAIL ") + "fincard".padEnd(12) + (fcard === "ok" ? "" : fcard));
if (fcard !== "ok") problems.push("fincard " + fcard);

/* 动态能发视频：编辑面板要有视频入口，草稿里能放视频缩略，播放地址走同一个媒体路由 */
const vcomp = await w.eval(`(async () => {
  try {
    S.tab = "status"; await render(); await new Promise((r) => setTimeout(r, 400));
    openComposer();
    const pick = document.getElementById("fd_vpick");
    const inp = document.getElementById("fd_vfile");
    if (!pick || !inp) return "没有视频入口";
    if (!/video/.test(inp.accept || "")) return "accept=" + inp.accept;
    if (typeof fdUploadVideo !== "function") return "没有 fdUploadVideo";
    if (!document.getElementById("fd_vbox")) return "没有上传排队区";
    if (fdVideoType(new File([], "a.mov")) !== "video/quicktime") return "mov 没按扩展名兜底";
    if (fdVideoType(new File([], "b.webm", { type: "" })) !== "video/webm") return "webm 没按扩展名兜底";
    if (typeof fdCanZip !== "function") return "没有压缩能力检测";
    FD_VJOBS = [{ file: new File([new Uint8Array(1024)], "x.mp4", { type: "video/mp4" }), mode: "err", err: "断网了", label: "" }];
    fdDrawVBox();
    const jobBtn = document.querySelector("#fd_vbox [data-vjob]");
    FD_VJOBS = [];
    if (!jobBtn) return "断点续传卡片没渲染";
    FD_DRAFT.push({ t: "v", u: "feed/2026-11/demo.mp4" });
    drawDraft();
    const tile = document.querySelector("#fd_ph video");
    const src = tile ? (tile.getAttribute("src") || "") : "";
    closeSheet(); FD_DRAFT = [];
    if (!tile) return "草稿里没有视频缩略";
    return src === "/api/fin/photo/feed/2026-11/demo.mp4" ? "ok" : "src=" + src;
  } catch (e) { return "THROW " + e.message; }
})()`);
console.log((vcomp === "ok" ? "  ok   " : "  FAIL ") + "feedvideo".padEnd(12) + (vcomp === "ok" ? "" : vcomp));
if (vcomp !== "ok") problems.push("feedvideo " + vcomp);

/* 银行卡选择器：有银行权限的角色，账单面板里必须真的列出已登记的卡（带卡号尾巴） */
const bankAllNow = await w.eval("!!FIN.bankAll");
const pick = await w.eval(`(async () => {
  try {
    finBankSheet();
    await new Promise((r) => setTimeout(r, 200));
    const sel = document.getElementById("bk_card");
    const n = sel ? sel.options.length : -1;
    const no = sel && sel.options[0] ? sel.options[0].dataset.no : "";
    const bad = sel && sel.options[0] ? /还没有登记银行卡/.test(sel.options[0].textContent) : true;
    document.querySelectorAll(".fin-dim").forEach((x) => x.remove());
    if (!sel) return "no select";
    if (no) return "ok";
    /* 没有银行权限的人本来是空的：出现「还没登记」提示也算正常 */
    return bad && !${bankAllNow} ? "ok" : "options=" + n + " no=" + no;
  } catch (e) { return "THROW " + e.message; }
})()`);
console.log((pick === "ok" ? "  ok   " : "  FAIL ") + "bankpick".padEnd(12) + (pick === "ok" ? "" : pick));
if (pick !== "ok") problems.push("bankpick " + pick);

/* 财务账目设置：改期初要真的写进去，初始化/删除不能炸 */
if (role === "boss") {
  const acct = await w.eval(`(async () => {
    try {
      S.tab = "finacct";
      await render();
      await new Promise((r) => setTimeout(r, 400));
      const box = document.querySelector('[data-set="boss@ecobox.com"]');
      if (!box) return "no card";
      /* 「报表期初」已下线：期初口径只有每人现金 + 每张卡，页面不该再有这块 */
      if (document.getElementById("fo_save") || /报表期初/.test(document.getElementById("pane").textContent)) return "report opening still there";
      box.querySelector('[data-f="cash"]').value = "777";
      const sb = box.querySelector('[data-save]');
      sb.click();
      /* 点完必须立刻有反应：按钮转成「处理中…」并禁用，底部浮条出现等待态 */
      const bar = document.getElementById("updbar");
      if (!sb.disabled || !/处理中/.test(sb.textContent)) return "no instant button feedback";
      if (!bar.className.includes("wait")) return "no instant bar feedback (" + bar.className + ")";
      await new Promise((r) => setTimeout(r, 800));
      const cash = document.querySelector('[data-set="boss@ecobox.com"] [data-f="cash"]');
      if (!cash || Number(cash.value) !== 777) return "save failed: " + (cash ? cash.value : "gone");
      const fresh = await api("/fin/bootstrap");
      const row = (fresh.accounts || []).find((a) => a.uid === "boss@ecobox.com");
      if (!row || Number(row.cash) !== 777) return "server cash " + (row && row.cash);

      /* 银行账号：加上去要落库，卡片上要能看见；「设置」里改期初、删卡 */
      const add = document.querySelector('[data-set="boss@ecobox.com"] .bl-add');
      if (!add) return "no bank box";
      add.querySelector('[data-bf="bank"]').value = "IZB";
      add.querySelector('[data-bf="no"]').value = "0391020000999";
      add.querySelector('[data-bf="ccy"]').value = "USD";
      const addName = add.querySelector('[data-bf="name"]');
      if (!addName) return "no name field in add row";
      addName.value = "工资户";
      document.querySelector('[data-set="boss@ecobox.com"] [data-badd]').click();
      await new Promise((r) => setTimeout(r, 800));
      const b4 = await api("/fin/bootstrap");
      const r4 = (b4.accounts || []).find((a) => a.uid === "boss@ecobox.com") || {};
      const banks4 = r4.banks || [];
      if (banks4.length !== 1 || banks4[0].bank !== "IZB" || banks4[0].no !== "0391020000999" || banks4[0].ccy !== "USD") return "bank add " + JSON.stringify(banks4);
      if (banks4[0].name !== "工资户") return "bank add name " + JSON.stringify(banks4[0]);
      if (!document.querySelector('[data-set="boss@ecobox.com"] .bl-row')) return "bank row missing";
      if (!(document.querySelector('[data-set="boss@ecobox.com"] .bl-row').textContent || "").includes("工资户")) return "add row name missing";
      /* 行尾是「设置」，点开填这张卡的期初 */
      const setBtn = document.querySelector('[data-set="boss@ecobox.com"] [data-bset]');
      if (!setBtn) return "no settings button";
      setBtn.click();
      await new Promise((r) => setTimeout(r, 300));
      const balIn = document.getElementById("bc_bal");
      if (!balIn) return "no bank card sheet";
      /* 卡名 / 户名是可选的，填了就跟着卡走，列表和下拉都用卡名 */
      document.getElementById("bc_name").value = "经营户";
      document.getElementById("bc_holder").value = "ECOMINE LTD";
      balIn.value = "1234.5";
      document.getElementById("bc_save").click();
      await new Promise((r) => setTimeout(r, 800));
      const b5 = await api("/fin/bootstrap");
      const r5 = (b5.accounts || []).find((a) => a.uid === "boss@ecobox.com") || {};
      if (!(r5.banks || []).length || Number(r5.banks[0].bal) !== 1234.5) return "bank bal " + JSON.stringify(r5.banks);
      if (r5.banks[0].name !== "经营户" || r5.banks[0].holder !== "ECOMINE LTD") return "bank name " + JSON.stringify(r5.banks[0]);
      const rowTxt = (document.querySelector('[data-set="boss@ecobox.com"] .bl-row') || {}).textContent || "";
      if (!rowTxt.includes("经营户")) return "row name " + rowTxt.trim();
      if (Number(r5.card) !== 1234.5) return "bank total " + r5.card;
      const cardIn = document.querySelector('[data-set="boss@ecobox.com"] [data-f="card"]');
      const cardTxt = cardIn ? String(cardIn.value) : "";
      if (!cardIn || Number(cardTxt.replace(/,/g, "")) !== 1234.5) return "card input " + cardTxt;
      /* 金额一律财务格式：千分位 + 两位小数 */
      if (cardTxt !== "1,234.50") return "card format " + cardTxt;
      /* 删除也在「设置」里 */
      document.querySelector('[data-set="boss@ecobox.com"] [data-bset]').click();
      await new Promise((r) => setTimeout(r, 300));
      const delCard = document.getElementById("bc_del");
      if (!delCard) return "no delete in sheet";
      delCard.click();
      await new Promise((r) => setTimeout(r, 800));
      const b6 = await api("/fin/bootstrap");
      const r6 = (b6.accounts || []).find((a) => a.uid === "boss@ecobox.com") || {};
      if ((r6.banks || []).length) return "bank del " + JSON.stringify(r6.banks);

      const init = document.querySelector('[data-set="boss@ecobox.com"] [data-init]');
      init.click();
      await new Promise((r) => setTimeout(r, 800));
      const b2 = await api("/fin/bootstrap");
      const row2 = (b2.accounts || []).find((a) => a.uid === "boss@ecobox.com");
      if (!row2 || Number(row2.cash) !== 0) return "init failed " + (row2 && row2.cash);

      const del = document.querySelector('[data-set="boss@ecobox.com"] [data-rm]');
      del.click();
      await new Promise((r) => setTimeout(r, 800));
      const b3 = await api("/fin/bootstrap");
      if ((b3.accounts || []).some((a) => a.uid === "boss@ecobox.com")) return "delete failed";
      return "ok";
    } catch (e) { return "THROW " + e.message; }
  })()`);
  console.log((acct === "ok" ? "  ok   " : "  FAIL ") + "acct-setup".padEnd(12) + (acct === "ok" ? "" : acct));
  if (acct !== "ok") problems.push("acct-setup " + acct);

  /* 银行原始单据：账户 → 卡 → 月份三级目录；卡内上传；月份里能删原件 */
  const bdocTree = await w.eval(`(async () => {
    try {
      const boot = await api("/fin/bootstrap");
      const co = (boot.accounts || []).find((a) => a.uid === "__company") || {};
      const card = (co.banks || [])[0];
      if (!card) return "no company card";
      const data = "data:application/pdf;base64," + btoa("%PDF-1.4 test");
      await api("/fin/bankdocs", { method: "POST", body: { card_id: card.id, period: "2026-11", name: "nov-statement.pdf", data } });
      S.tab = "bankdoc";
      BDOC_CARD = ""; BDOC_MONTH = "";
      await render();
      await new Promise((r) => setTimeout(r, 700));
      const total = (boot.accounts || []).reduce((n, a) => n + (a.banks || []).filter((b) => b.id).length, 0);
      const dirs = document.querySelectorAll("[data-bdcardopen]");
      if (dirs.length !== total) return "root dirs " + dirs.length + "/" + total;
      if (document.querySelector("[data-bdocopen]")) return "docs leak on root page";
      if (document.getElementById("bdoc_new")) return "top upload button still there";
      const dir = document.querySelector('[data-bdcardopen="' + card.id + '"]');
      if (!dir) return "company dir missing";
      if (!/2026-11/.test(dir.textContent || "")) return "month range missing on dir";
      if (!/11-01 → 11-30/.test(dir.textContent || "")) return "card period range missing";
      /* 卡内上传：卡写死 */
      dir.querySelector("[data-bdupload]").click();
      await new Promise((r) => setTimeout(r, 250));
      const ci = document.getElementById("bd_card");
      if (!ci || ci.tagName !== "INPUT" || ci.value !== card.id) return "upload asks for card again";
      document.getElementById("bd_cancel").click();
      await new Promise((r) => setTimeout(r, 100));
      /* 二级：月份目录 */
      document.querySelector('[data-bdcardopen="' + card.id + '"]').click();
      await new Promise((r) => setTimeout(r, 700));
      const mb = document.querySelector('[data-bdmonth="2026-11"]');
      if (!mb) return "month dir missing";
      if (document.querySelector("[data-bdocopen]")) return "docs leak on card page";
      if (!/11-01 → 11-30/.test(mb.textContent || "")) return "month period range missing";
      if (!document.querySelector("[data-bdpath]")) return "no breadcrumb";
      /* 三级：原件 + 删除 */
      mb.click();
      await new Promise((r) => setTimeout(r, 700));
      const row = document.querySelector("[data-bdocopen]");
      if (!row) return "doc row missing";
      if (!/nov-statement\.pdf/.test(row.textContent || "")) return "file name missing";
      if (!/11-01 → 11-30/.test(row.textContent || "")) return "doc period range missing";
      if (!document.querySelector("[data-bdocdel]")) return "no delete button";
      /* 改期间：录错了能直接修，不重传文件 */
      if (!document.querySelector("[data-bdocedit]")) return "no edit-period button";
      document.querySelector("[data-bdocedit]").click();
      await new Promise((r) => setTimeout(r, 300));
      const ep = document.getElementById("be_pf"), et = document.getElementById("be_pt");
      if (!ep || !et) return "edit-period sheet missing";
      ep.value = "2026-11-03"; et.value = "2026-11-20";
      document.getElementById("be_save").click();
      await new Promise((r) => setTimeout(r, 900));
      const row2 = document.querySelector("[data-bdocopen]");
      if (!row2 || !/11-03 → 11-20/.test(row2.textContent || "")) return "edited period not shown: " + (row2 && row2.textContent);
      window.confirm = () => true;
      document.querySelector("[data-bdocdel]").click();
      await new Promise((r) => setTimeout(r, 1200));
      const left = (await api("/fin/bankdocs")).docs || [];
      if (left.some((d) => d.file_name === "nov-statement.pdf")) return "delete did not remove";
      if (document.querySelector('[data-bdmonth="2026-11"]')) return "empty month dir left behind";
      return "ok";
    } catch (e) { return "THROW " + e.message; }
  })()`);
  console.log((bdocTree === "ok" ? "  ok   " : "  FAIL ") + "bankdoc-tree".padEnd(12) + (bdocTree === "ok" ? "" : bdocTree));
  if (bdocTree !== "ok") problems.push("bankdoc-tree " + bdocTree);

  /* 银行账单：只读；账单由「银行原始单据」数字化产生；月份里看流水 / 删单 */
  const bkTree = await w.eval(`(async () => {
    try {
      const boot = await api("/fin/bootstrap");
      const co = (boot.accounts || []).find((a) => a.uid === "__company") || {};
      const card = (co.banks || [])[0];
      if (!card) return "no company card";
      const data = "data:application/pdf;base64," + btoa("%PDF-1.4 src");
      const doc = await api("/fin/bankdocs", { method: "POST", body: { card_id: card.id, period: "2026-09", name: "sep-src.pdf", data } });
      const st = await api("/fin/bank", { method: "POST", body: {
        card_id: card.id, doc_id: doc.id, pf: "2026-09-01", pt: "2026-09-30",
        open_bal: 1000, close_bal: 1200, total_in: 500, total_out: 300,
        parse_by: "manual", txs: [],
      }, quiet: true });
      await api("/fin/bank", { method: "POST", body: {
        card_id: card.id, doc_id: doc.id, pf: "2026-09-01", pt: "2026-09-30",
        open_bal: 1000, close_bal: 1200, total_in: 500, total_out: 300,
        parse_by: "manual", txs: [],
      }, quiet: true });
      S.tab = "bank";
      BANK_CARD = ""; BANK_MONTH = ""; BANK_OLD = false;
      await render();
      await new Promise((r) => setTimeout(r, 700));
      if (document.querySelector("[data-bkupload]")) return "upload entry still on bank page";
      if (document.getElementById("bk_file")) return "upload sheet still on bank page";
      const total = (boot.accounts || []).reduce((n, a) => n + (a.banks || []).filter((b) => b.id).length, 0);
      const dirs = document.querySelectorAll("[data-bkcard]");
      if (dirs.length !== total) return "root dirs " + dirs.length + "/" + total;
      if (document.querySelector("[data-bankopen]")) return "statements leak on root page";
      if (!document.querySelector('[data-go="bankdoc"]')) return "no link to originals";
      if (!document.querySelector(".bkd-hero")) return "no ledger header";
      if (!document.querySelector('[data-bkcard].on')) return "selected card tab missing";
      const dir = document.querySelector('[data-bkcard="' + card.id + '"]');
      if (!dir) return "company tab missing";
      if (!dir.className.includes("on")) return "company tab not selected";
      const mb = document.querySelector('[data-bkmonth="2026-09"]');
      if (!mb) return "month row missing";
      if (!/1,200\.00/.test(mb.textContent || "")) return "month close missing";
      if (!/09-01 → 09-30/.test(mb.textContent || "")) return "month span missing: " + mb.textContent;
      if (!/1 份/.test(mb.textContent || "")) return "month row counts old versions: " + mb.textContent;
      if (document.querySelector("[data-bankopen]")) return "statements leak on card page";
      mb.click();
      await new Promise((r) => setTimeout(r, 700));
      const sheet = document.querySelector(".bkd-sheet");
      if (!sheet) return "statement sheet missing";
      if (!/sep-src\.pdf/.test(sheet.textContent || "")) return "source file name missing";
      if (!/1,200\.00/.test(sheet.textContent || "")) return "sheet close missing";
      if (!/1,000\.00/.test(sheet.textContent || "")) return "sheet opening missing";
      if (!/09-01 → 09-30/.test(sheet.textContent || "")) return "sheet span missing";
      if (!document.querySelector("[data-bkpath]")) return "no breadcrumb";
      if (document.querySelectorAll(".bkd-sheet").length !== 1) return "old version shown by default";
      const oldBtn = document.querySelector("[data-bkold]");
      if (!oldBtn) return "no old-version toggle";
      if (!/1 份/.test(oldBtn.textContent || "")) return "old toggle count wrong: " + oldBtn.textContent;
      oldBtn.click();
      await new Promise((r) => setTimeout(r, 500));
      if (document.querySelectorAll(".bkd-sheet").length !== 2) return "old version not expandable";
      if (document.querySelectorAll(".bkd-sheet.dim").length !== 1) return "old version not dimmed";
      /* 原件页：已经数字化过的原件要显示张数，并且不给直接删（先删账单） */
      S.tab = "bankdoc"; BDOC_CARD = card.id; BDOC_MONTH = "2026-09";
      await render();
      await new Promise((r) => setTimeout(r, 700));
      const drow = [...document.querySelectorAll("[data-bdocopen]")].find((x) => /sep-src\.pdf/.test(x.textContent || ""));
      if (!drow) return "doc row missing on originals page: " + String(document.querySelector("#pane").textContent || "").slice(0, 140);
      if (!/已数字化 1/.test(drow.textContent || "")) return "doc row count wrong: " + drow.textContent;
      if (drow.querySelector("[data-bdocdel]:not([disabled])")) return "doc delete still enabled with statements";
      if (!drow.querySelector("[data-bdocedit]")) return "no edit-period button";
      S.tab = "bank"; BANK_CARD = card.id; BANK_MONTH = "2026-09"; BANK_OLD = true;
      await render();
      await new Promise((r) => setTimeout(r, 700));
      const del = document.querySelector(".bkd-sheet:not(.dim) [data-bkdel]");
      if (!del) return "no delete button";
      window.confirm = () => true;
      del.click();
      await new Promise((r) => setTimeout(r, 1200));
      const after = (await api("/fin/bank")).stmts || [];
      if (after.some((s) => !Number(s.old) && s.card_id === card.id && s.pf === "2026-09-01")) return "delete did not remove";
      const mrow = document.querySelector('[data-bkmonth="2026-09"]');
      if (!mrow) return "history-only month row missing";
      if (!/历史版本 1 份/.test(mrow.textContent || "")) return "history-only row text: " + mrow.textContent;
      if (document.querySelector(".bkd-sheet")) return "sheet left after delete";
      if (!document.querySelector(".bkd-hero")) return "not back at ledger level";
      for (const s of ((await api("/fin/bank")).stmts || [])) {
        if (s.card_id === card.id && s.pf === "2026-09-01") await api("/fin/bank/" + s.id, { method: "DELETE", quiet: true });
      }
      await api("/fin/bankdocs/" + doc.id, { method: "DELETE", quiet: true });
      return "ok";
    } catch (e) { return "THROW " + e.message; }
  })()`);
  console.log((bkTree === "ok" ? "  ok   " : "  FAIL ") + "bank-tree".padEnd(12) + (bkTree === "ok" ? "" : bkTree));
  if (bkTree !== "ok") problems.push("bank-tree " + bkTree);

}

/* 手机全屏按钮：非 standalone 时必须能看见，点了不能炸 */
const fsBtn = await w.eval(`(async () => {
  const b = document.getElementById("fsbtn");
  if (!b) return "missing";
  if (b.classList.contains("hide")) return "hidden";
  try { b.click(); await new Promise((r) => setTimeout(r, 100)); return "ok"; }
  catch (e) { return "THROW " + e.message; }
})()`);
console.log((fsBtn === "ok" ? "  ok   " : "  FAIL ") + "fsbtn".padEnd(12) + (fsBtn === "ok" ? "" : fsBtn));
if (fsBtn !== "ok") problems.push("fsbtn " + fsBtn);

/* 金额一律财务格式：1,000,000.00（千分位 + 两位小数），列表和输入框都算 */
const fmtAll = role === "boss";
const fmt = await w.eval(`(async () => {
  try {
    if (finMoney(1234567.891) !== "1,234,567.89") return "helper " + finMoney(1234567.891);
    if (moneyNum("1,234,567.89") !== 1234567.89) return "parse " + moneyNum("1,234,567.89");
    S.tab = "fin"; await render();
    await new Promise((r) => setTimeout(r, 500));
    const txt = document.getElementById("pane").textContent || "";
    if (${fmtAll}) {
      if (!txt.includes("1,234,567.89")) return "list " + (txt.match(/\\d[\\d,]*\\.\\d\\d/g) || []).slice(0, 4).join("|");
      const raw = (txt.match(/(^|[^,\\d.])1234567(\\.\\d+)?([^\\d]|$)/) || [])[0];
      if (raw) return "raw " + raw.trim();
    }
    S.tab = "finacct"; await render();
    await new Promise((r) => setTimeout(r, 500));
    const cash = document.querySelector('[data-f="cash"]');
    if (cash && !/^\\d{1,3}(,\\d{3})*\\.\\d\\d$/.test(cash.value)) return "input " + cash.value;
    return "ok";
  } catch (e) { return "THROW " + e.message; }
})()`);
console.log((fmt === "ok" ? "  ok   " : "  FAIL ") + "moneyfmt".padEnd(12) + (fmt === "ok" ? "" : fmt));
if (fmt !== "ok") problems.push("moneyfmt " + fmt);

console.log(problems.length ? "FAILED " + problems.length : "OK 页面渲染全通(" + role + ")");
server.close();
process.exit(problems.length ? 1 : 0);
