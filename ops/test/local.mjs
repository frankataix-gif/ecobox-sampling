/* 本地跑真 Worker 逻辑：node:sqlite 当 D1，真 HTTP 请求，不用 mock。
 * 用法：node ops/test/local.mjs
 */
import http from "node:http";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = fs.readFileSync(path.join(ROOT, "schema.sql"), "utf8");

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
globalThis.__OPS_PAGE__ = "<!doctype html><title>ops</title>";
const { default: worker } = await import(pathToFileURL(path.join(ROOT, "worker.js")).href);

// R2 内存替身：只为验证 Worker 的读写逻辑，不模拟 R2 本身
const R2 = new Map();
const PHOTOS = {
  async put(key, bytes, opts = {}) {
    R2.set(key, { bytes, mime: (opts.httpMetadata && opts.httpMetadata.contentType) || "" });
    return { key };
  },
  async get(key) {
    const o = R2.get(key);
    return o ? { body: o.bytes, httpMetadata: { contentType: o.mime } } : null;
  },
  async head(key) { return R2.has(key) ? { key } : null; },
  async delete(key) { R2.delete(key); },
  async list() { return { objects: [] }; },
};

const env = { DB: new D1(db), SETUP_TOKEN: "setup-abc", FIN_OWNER: "boss@ecobox.com", PHOTOS };

async function startServer(w, e) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const url = "http://127.0.0.1:" + server.address().port + req.url;
    const r = await w.fetch(new Request(url, { method: req.method, headers: req.headers, body }), e, {});
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(await r.text());
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  server.base = "http://127.0.0.1:" + server.address().port;
  return server;
}
const server = await startServer(worker, env);
const BASE = server.base;

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log("FAIL " + msg); } };

function client(base = BASE) {
  let cookie = "";
  return async (p, opts = {}) => {
    const r = await fetch(base + p, {
      method: opts.method || "GET",
      headers: { ...(opts.form ? {} : { "content-type": "application/json" }), ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
      body: opts.form || (opts.body ? JSON.stringify(opts.body) : undefined),
      redirect: opts.redirect || "follow",
    });
    const sc = r.headers.get("set-cookie");
    if (sc) {
      const m = sc.match(/ops_sess=([^;]*)/);
      if (m) cookie = m[1] ? "ops_sess=" + m[1] : "";
    }
    let data = null;
    const txt = await r.text();
    try { data = JSON.parse(txt); } catch { data = txt; }
    return { status: r.status, data, headers: r.headers };
  };
}

const anon = client();
const post = (c, p, body, headers) => c(p, { method: "POST", body, headers });
const patch = (c, p, body) => c(p, { method: "PATCH", body });

/* 1. 页面与未登录 */
ok((await anon("/")).status === 200, "GET / 返回页面");
ok((await anon("/api/me")).data.user === null, "未登录时 /api/me 返回 null");
ok((await anon("/api/logs")).status === 401, "未登录读日报被拒");
ok((await anon("/api/status")).data.setup_needed === true, "空库时页面要求初始化");

/* 2. 初始化 */
ok((await post(anon, "/api/setup", { login: "boss@ecobox.com", name: "老板", password: "ecobox2026" })).status === 403, "无口令不许初始化");
ok((await post(anon, "/api/setup", { login: "boss@ecobox.com", name: "老板", password: "ecobox2026" }, { "x-setup-token": "setup-abc" })).status === 200, "用口令初始化管理员");
ok((await post(anon, "/api/setup", { login: "x@ecobox.com", name: "x", password: "12345678" }, { "x-setup-token": "setup-abc" })).status === 409, "重复初始化被拒");
ok((await anon("/api/status")).data.setup_needed === false, "初始化后不再显示初始化");

/* 3. 登录 */
const boss = client();
ok((await post(boss, "/api/login", { login: "boss@ecobox.com", password: "wrong" })).status === 401, "错密码 401");
ok((await post(boss, "/api/login", { login: "BOSS@ecobox.com", password: "ecobox2026" })).status === 200, "邮箱大小写不影响登录");
const me = (await boss("/api/me")).data.user;
ok(me && me.role === "admin" && me.login === "boss@ecobox.com", "登录后拿到 admin 身份");

/* 4. 日报写入 */
const bad = await post(boss, "/api/logs", { day: "2026/11/01", site: "Serenje" });
ok(bad.status === 400, "日期格式错误被拒绝" + bad.data.error);
ok((await post(boss, "/api/logs", { day: "2026-11-01" })).status === 400, "缺矿区被拒");
const c1 = await post(boss, "/api/logs", { day: "2026-11-01", site: "Serenje 1330NW", headcount: 8, ore_t: 12.5, waste_t: 30, cost_usd: 420, note: "现场记录" });
ok(c1.status === 201, "新建日报");
const c2 = await post(boss, "/api/logs", { day: "2026-11-02", site: "Serenje 1330NW", headcount: 6, ore_t: 7.5, cost_usd: 100, note: "下雨停工半天" });
ok(c2.status === 201, "再建第二条");
const negative = await post(boss, "/api/logs", { day: "2026-11-02", site: "Serenje 1330NW", headcount: -5, ore_t: -3 });
const negRow = (await boss("/api/logs?from=2026-11-02&to=2026-11-02")).data.logs[0];
ok(negative.status === 201 && negRow.headcount === 0 && negRow.ore_t === 0, "负数被夹到 0");

/* 5. 共享读取 + 汇总 */
const all = (await boss("/api/logs?from=2026-11-01&to=2026-11-30")).data.logs;
ok(all.length === 3 && all[0].user_name === "老板", "列表带录入人");
const sum = (await boss("/api/summary?from=2026-11-01&to=2026-11-30")).data;
ok(sum.totals.entries === 3 && sum.totals.ore_t === 20 && sum.totals.man_days === 14, "汇总：3 条 / 20 吨 / 14 人天（实=" + JSON.stringify(sum.totals) + "）");
ok(sum.by_site.length === 1 && sum.by_site[0].site === "Serenje 1330NW", "按矿区汇总");

/* 6. 人员管理 + 权限隔离 */
ok((await post(boss, "/api/users", { login: "a b", name: "x", password: "12345678" })).status === 400, "账号带空格被拒");
ok((await post(boss, "/api/users", { login: "k@ecobox.com", name: "K", password: "short" })).status === 400, "短密码被拒");
const mk = await post(boss, "/api/users", { login: "k@ecobox.com", name: "肯尼", password: "kenny2026", role: "staff", site: "Serenje 1330NW" });
ok(mk.status === 201, "开普通员工账号");
ok((await post(boss, "/api/users", { login: "k@ecobox.com", name: "重复", password: "kenny2026" })).status === 409, "邮箱唯一");
ok((await post(boss, "/api/users", { name: "K张", password: "short" })).status === 400, "开账号不填账号也要查密码长度");
ok((await post(boss, "/api/users", { name: "吴名", password: "noname123" })).status === 201, "账号留空时用姓名当账号");
ok((await post(client(), "/api/login", { login: "吴名", password: "noname123" })).status === 200, "能用姓名登录");
ok((await post(boss, "/api/users", { name: "吴名", password: "noname123" })).status === 409, "同姓名不能重复开号");
ok((await post(boss, "/api/users", { name: "吴 名", password: "noname123" })).status === 400, "账号不能带空格");

const staff = client();
ok((await post(staff, "/api/login", { login: "k@ecobox.com", password: "kenny2026" })).status === 200, "员工登录");
ok((await staff("/api/users")).status === 403, "员工不能看账号列表");
ok((await post(staff, "/api/users", { login: "z@ecobox.com", name: "z", password: "12345678" })).status === 403, "员工不能开账号");
ok((await staff("/api/logs?from=2026-11-01&to=2026-11-30")).data.logs.length === 3, "员工能看全公司数据（共享）");
ok((await patch(staff, "/api/logs/" + c1.data.id, { note: "改别人的" })).status === 403, "员工不能改别人的记录");
const own = await post(staff, "/api/logs", { day: "2026-11-03", site: "Serenje 1330NW", headcount: 4, ore_t: 2 });
ok(own.status === 201, "员工能录自己的");
ok((await patch(staff, "/api/logs/" + own.data.id, { ore_t: 3 })).status === 200, "员工能改自己的");

const mgr = client();
await post(boss, "/api/users", { login: "m@ecobox.com", name: "经理", password: "mgr2026x", role: "manager" });
await post(mgr, "/api/login", { login: "m@ecobox.com", password: "mgr2026x" });
ok((await patch(mgr, "/api/logs/" + c2.data.id, { note: "经理校正" })).status === 200, "负责人能改全部记录");
ok((await mgr("/api/users")).status === 403, "负责人不能管账号");

/* 7. CSRF */
const evil = await boss("/api/logs", { method: "POST", body: { day: "2026-11-04", site: "Serenje" }, headers: { origin: "https://evil.example.com" } });
ok(evil.status === 403, "跨站来源被拒");

/* 8. 改密码 */
const staff2 = client();
ok((await post(staff2, "/api/login", { login: "k@ecobox.com", password: "kenny2026" })).status === 200, "员工在第二台设备登录");
ok((await post(staff, "/api/password", { old: "nope", new: "newpass123" })).status === 403, "原密码错被拒");
ok((await post(staff, "/api/password", { old: "kenny2026", new: "123" })).status === 400, "新密码太短被拒");
ok((await post(staff, "/api/password", { old: "kenny2026", new: "newpass123" })).status === 200, "改密码成功");
ok((await staff("/api/me")).data.user !== null, "改密码的这台设备仍在用");
ok((await staff2("/api/me")).data.user === null, "同一账号在另一台设备的会话被踢下线");

/* 9. 管理员保护自己 */
const bossId = me.id;
ok((await patch(boss, "/api/users/" + bossId, { role: "staff" })).status === 409, "不能把自己降级");
ok((await patch(boss, "/api/users/" + bossId, { active: 0 })).status === 409, "不能把自己停用");
ok((await patch(boss, "/api/users/" + bossId, { name: "老板 Frank" })).status === 200, "能改自己名字");

/* 10. 停用账号 & 删除 */
await patch(boss, "/api/users/" + mk.data.id, { active: 0 });
const blocked = await post(client(), "/api/login", { login: "k@ecobox.com", password: "newpass123" });
ok(blocked.status === 401, "停用账号不能登录");
ok((await boss("/api/logs/" + own.data.id, { method: "DELETE" })).status === 200, "删除记录");
ok((await boss("/api/logs?from=2026-11-01&to=2026-11-30")).data.logs.length === 3, "删后剩 3 条");
const auditCount = db.prepare("SELECT COUNT(*) c FROM audit").get().c;
ok(auditCount >= 8, "写操作都留了审计（" + auditCount + " 条）");

/* 10.5 模块权限 */
const cat = await boss("/api/modules");
ok(cat.status === 200 && cat.data.modules.length >= 8, "模块目录可读");
const keys = cat.data.modules.map((m) => m.k);
ok(cat.data.modules.find((m) => m.k === "users").t === "会员设置", "系统里的账号页叫「会员设置」");
ok(cat.data.modules.find((m) => m.k === "lic").g === "资产", "矿山项目介绍归到「资产」");
ok(!cat.data.modules.some((m) => m.g === "项目资料"), "「项目资料」分组已并入资产", cat.data.modules.map((m) => m.g).join(","));
ok(keys.includes("lic") && keys.includes("sampling"), "目录里有矿证资料与取样记录本");
const finMod = cat.data.modules.find((m) => m.k === "finance");
ok(finMod && finMod.t === "费用记录" && finMod.g === "财务", "账目模块叫「费用记录」，仍挂在「财务」分组下", JSON.stringify(finMod));
ok((await client()("/api/modules")).status === 401, "未登录看不到模块目录");
ok((await boss("/api/me")).data.user.modules.length === keys.length, "管理员默认全开");

const lim = await post(boss, "/api/users", { login: "lim@ecobox.com", name: "李民", password: "lim2026pass", role: "staff", modules: ["log", "lic"] });
ok(lim.status === 201, "开账号时能指定模块");
const limc = client();
await post(limc, "/api/login", { login: "lim@ecobox.com", password: "lim2026pass" });
const limMe = (await limc("/api/me")).data.user;
ok(limMe.modules.slice().sort().join(",") === "lang,lic,log,mine", "员工只拿到勾选的模块 + 我的 + 语言（" + limMe.modules.join(",") + "）");
ok(!limMe.modules.includes("users"), "员工没有人员模块");

ok((await patch(boss, "/api/users/" + lim.data.id, { modules: ["log", "sampling", "mine"] })).status === 200, "管理员能改模块");
ok((await limc("/api/me")).data.user.modules.slice().sort().join(",") === "lang,log,mine,sampling", "改完立刻生效");
await patch(boss, "/api/users/" + lim.data.id, { modules: ["users", "lic"] });
const after = (await limc("/api/me")).data.user.modules;
ok(!after.includes("users"), "人员模块不会被下放给员工");
ok(after.includes("lic"), "非法键被丢掉，合法键保留");
ok((await limc("/api/users")).status === 403, "没有人员模块也调不到账号接口");

/* 12. 财务：人员转账（现金 / 银行卡） */
const putAcct = (c, uid, body) => c("/api/fin/accounts/" + encodeURIComponent(uid), { method: "PUT", body });
const today = new Date().toISOString().slice(0, 10);
ok((await post(boss, "/api/users", { login: "peter@ecobox.com", name: "彼得", password: "peter2026", role: "staff" })).status === 201, "开普通彼得账号");
ok((await putAcct(boss, "boss@ecobox.com", { name: "老板", cash: 1000, card: 500 })).status === 200, "设老板账户");
ok((await putAcct(boss, "peter@ecobox.com", { name: "彼得", cash: 100, card: 50 })).status === 200, "设彼得账户");

const t1 = await post(boss, "/api/fin/entries", { kind: "transfer", uid: "boss@ecobox.com", ch: "cash",
  to_uid: "peter@ecobox.com", to_ch: "card", amount: 200, date: today, note: "现金换银行" });
ok(t1.status === 201, "老板 → 彼得 转账（现金 → 银行）");
const trow = db.prepare("SELECT * FROM fin_entries WHERE id=?").get(t1.data.id);
ok(trow && trow.uid === "boss@ecobox.com" && trow.to_uid === "peter@ecobox.com" && trow.ch === "cash" &&
   trow.to_ch === "card" && trow.amount === 200 && trow.cat === "" && trow.ft === "life", "转账落库字段正确");

ok((await post(boss, "/api/fin/entries", { kind: "transfer", uid: "boss@ecobox.com", to_uid: "boss@ecobox.com", amount: 5, date: today })).status === 400, "不能转给自己");
ok((await post(boss, "/api/fin/entries", { kind: "transfer", uid: "boss@ecobox.com", amount: 5, date: today })).status === 400, "转账必须选转入人");
ok((await post(boss, "/api/fin/entries", { kind: "transfer", uid: "boss@ecobox.com", to_uid: "peter@ecobox.com", amount: 0, date: today })).status === 400, "转账金额必须大于 0");

const peter = client();
ok((await post(peter, "/api/login", { login: "peter@ecobox.com", password: "peter2026" })).status === 200, "彼得登录");
const sp = await post(peter, "/api/fin/entries", { kind: "transfer", uid: "peter@ecobox.com", ch: "cash",
  to_uid: "boss@ecobox.com", to_ch: "cash", amount: 10, date: today });
ok(sp.status === 403, "员工不能登记人员转账");
ok(!db.prepare("SELECT id FROM fin_entries WHERE kind='transfer' AND uid='peter@ecobox.com'").get(), "员工转账没有落库");

const m2 = await post(mgr, "/api/fin/entries", { kind: "transfer", uid: "m@ecobox.com", ch: "cash",
  to_uid: "peter@ecobox.com", to_ch: "cash", amount: 50, date: today });
ok(m2.status === 201, "负责人能从自己账号转账给员工");
const m2row = db.prepare("SELECT * FROM fin_entries WHERE id=?").get(m2.data.id);
ok(m2row && m2row.uid === "m@ecobox.com" && m2row.to_uid === "peter@ecobox.com", "负责人转账按自己 + 指定员工落库");
const mgrToBoss = await post(mgr, "/api/fin/entries", { kind: "transfer", uid: "m@ecobox.com", ch: "cash",
  to_uid: "boss@ecobox.com", to_ch: "cash", amount: 5, date: today });
ok(mgrToBoss.status === 403, "负责人不能转给管理员（超出可见范围）", "status=" + mgrToBoss.status);
ok((await post(mgr, "/api/fin/entries", { kind: "out", uid: "lim@ecobox.com", ch: "cash", date: today,
  amount: 4, cat: "misc", ft: "life", note: "负责人替员工记" })).status === 403, "负责人不能替员工记账");
const pboot = (await peter("/api/fin/bootstrap")).data.entries;
ok(pboot.some((e) => e.kind === "transfer" && e.to_uid === "peter@ecobox.com" && e.amount === 50), "转入人在 bootstrap 看到转账");
ok(pboot.every((e) => e.uid === "peter@ecobox.com" || e.to_uid === "peter@ecobox.com"), "员工只看到与自己有关的记录");

ok((await patch(boss, "/api/fin/entries/" + t1.data.id, { amount: 250, date: today, ch: "card",
  to_uid: "peter@ecobox.com", to_ch: "cash", note: "改方向" })).status === 200, "修改转账");
const trow2 = db.prepare("SELECT * FROM fin_entries WHERE id=?").get(t1.data.id);
ok(trow2.amount === 250 && trow2.ch === "card" && trow2.to_ch === "cash", "修改后方向与金额生效");
ok((await patch(peter, "/api/fin/entries/" + t1.data.id, { amount: 1, date: today })).status === 403, "员工不能改别人的转账");
ok((await mgr("/api/fin/entries/" + m2.data.id, { method: "DELETE" })).status === 200, "本人能删自己的转账");

/* 余额：转出人减少、转入人增加，公司总额不变 */
function finBal(uid) {
  const rows = db.prepare("SELECT * FROM fin_entries").all();
  const bal = { cash: 0, card: 0 };
  const acc = db.prepare("SELECT * FROM fin_accounts WHERE uid=?").get(uid);
  if (acc) { bal.cash = acc.cash; bal.card = acc.card; }
  const chOf = (c) => (c === "card" ? "card" : "cash");
  for (const e of rows) {
    const amt = e.amount, ch = chOf(e.ch);
    if (e.kind === "transfer") {
      if (e.uid === uid) bal[ch] -= amt;
      if (e.to_uid === uid) bal[chOf(e.to_ch || e.ch)] += amt;
    }
  }
  return bal;
}
const bb = finBal("boss@ecobox.com"), pb = finBal("peter@ecobox.com");
ok(bb.card === 250 && bb.cash === 1000, "转出人余额正确（银行 500→250）：" + JSON.stringify(bb));
ok(pb.cash === 350 && pb.card === 50, "转入人余额正确（现金 100+250）：" + JSON.stringify(pb));
ok(bb.cash + bb.card + pb.cash + pb.card === 1650, "转账后公司总额不变（1650）");

/* 12b. 公司账户作为上级户：公司 → 员工 调拨 */
const co1 = await post(boss, "/api/fin/entries", { kind: "transfer", uid: "__company", ch: "card",
  to_uid: "peter@ecobox.com", to_ch: "cash", amount: 300, date: today });
ok(co1.status === 201, "公司账户能调款给员工");
const coRow = co1.data && co1.data.id ? db.prepare("SELECT * FROM fin_entries WHERE id=?").get(co1.data.id) : null;
ok(coRow && coRow.uid === "__company" && coRow.to_uid === "peter@ecobox.com" && coRow.ch === "card", "公司调款按公司账户落账");
ok((await post(peter, "/api/fin/entries", { kind: "transfer", uid: "__company", ch: "card",
  to_uid: "peter@ecobox.com", to_ch: "cash", amount: 10, date: today })).status === 403, "员工不能动公司账户");
ok((await putAcct(boss, "__company", { name: "公司账户", cash: 0, card: 20000, since: today })).status === 200, "能设公司账户余额");
const bt = (await boss("/api/fin/bootstrap")).data;
ok((bt.accounts || []).some((a) => a.uid === "__company" && a.card === 20000), "bootstrap 返回公司账户");

/* 17. 人员：编辑 + 删除（软删，历史保留，账号名腾出） */
const ed = await post(boss, "/api/users", { name: "李四", password: "lisi2026x", role: "staff", phone: "0971" });
ok(ed.status === 201, "开一个待编辑账号");
const edId = ed.data.id;
ok((await patch(boss, "/api/users/" + edId, { name: "李四玲", login: "lisi@ecobox.com", phone: "0966", role: "manager" })).status === 200, "编辑姓名/账号/电话/角色");
const edRow = (await boss("/api/users")).data.users.find((u) => u.id === edId);
ok(edRow && edRow.name === "李四玲" && edRow.login === "lisi@ecobox.com" && edRow.phone === "0966" && edRow.role === "manager", "编辑结果落库", JSON.stringify(edRow));
ok((await patch(boss, "/api/users/" + edId, { login: "k@ecobox.com" })).status === 409, "改账号撞名被拒");
ok((await patch(boss, "/api/users/" + edId, { login: "a b" })).status === 400, "改账号不能带空格");
const edc = client();
ok((await post(edc, "/api/login", { login: "lisi@ecobox.com", password: "lisi2026x" })).status === 200, "改完账号能用新账号登录");
const edLog = await post(edc, "/api/logs", { day: "2026-10-15", site: "Serenje 1330NW", headcount: 2, ore_t: 1 });
ok(edLog.status === 201, "被删前先留一条日报");
ok((await boss("/api/users/" + edId, { method: "DELETE" })).status === 200, "删除账号");
ok(!(await boss("/api/users")).data.users.some((u) => u.id === edId), "删除后不在账号列表");
ok((await post(client(), "/api/login", { login: "lisi@ecobox.com", password: "lisi2026x" })).status === 401, "删除后不能登录");
const keepLog = (await boss("/api/logs?from=2026-10-01&to=2026-10-31")).data.logs.find((l) => l.id === edLog.data.id);
ok(keepLog && keepLog.user_name === "李四玲", "删除的人录过的日报还在，名字保留", JSON.stringify(keepLog));
ok((await post(boss, "/api/users", { name: "李四玲", login: "lisi@ecobox.com", password: "lisi2026y" })).status === 201, "删掉后账号名可以再用");
ok((await boss("/api/users/" + (await boss("/api/me")).data.user.id, { method: "DELETE" })).status === 409, "不能删除自己");
ok((await boss("/api/users/" + edId, { method: "DELETE" })).status === 404, "重复删除返回 404");

/* 18. 岗位：财务 */
ok((await post(boss, "/api/users", { login: "fin@ecobox.com", name: "小财", password: "finance2026", role: "finance" })).status === 201, "能开「财务」岗位");
const finRow = (await boss("/api/users")).data.users.find((u) => u.login === "fin@ecobox.com");
ok(finRow && finRow.role === "finance", "角色存为 finance（不会被降成员工）", JSON.stringify(finRow));
const finC = client();
ok((await post(finC, "/api/login", { login: "fin@ecobox.com", password: "finance2026" })).status === 200, "财务能登录");
const fb = (await finC("/api/fin/bootstrap")).data;
ok(fb.canAll === true && fb.owner === false, "财务：能看全部账，但不是负责人", JSON.stringify({ canAll: fb.canAll, owner: fb.owner }));
ok((await post(finC, "/api/fin/entries", { kind: "out", uid: "boss@ecobox.com", date: today, amount: 12, cat: "meal", ch: "cash", note: "财务代记" })).status === 403, "财务也不能替别人记账");
const finOwn = await post(finC, "/api/fin/entries", { kind: "out", uid: "fin@ecobox.com", date: today, amount: 12, cat: "meal", ch: "cash", note: "财务自己记" });
ok(finOwn.status === 201, "财务记自己的账正常");
const admCoEntry = await post(boss, "/api/fin/entries", { kind: "out", uid: "boss@ecobox.com", date: today, amount: 7, cat: "meal", ch: "cash", note: "老板记的" });
ok((await finC("/api/fin/entries/" + admCoEntry.data.id + "/inv", { method: "PUT", body: { inv: 1 } })).status === 200, "财务能标别人的票");
ok((await finC("/api/users")).status === 403, "财务不能管账号");
const bossLog = await post(boss, "/api/logs", { day: "2026-10-16", site: "Serenje 1330NW", headcount: 1, ore_t: 1 });
const finLogPatch = await patch(finC, "/api/logs/" + bossLog.data.id, { note: "财务改日报" });
ok(finLogPatch.status === 403, "财务不能改别人的日报", "status=" + finLogPatch.status);
ok((await finC("/api/fin/accounts/boss@ecobox.com", { method: "PUT", body: { cash: 1 } })).status === 403, "财务不能改余额（负责人专属）");
ok((await finC("/api/fin/cats/merge", { method: "POST" })).status === 403, "财务不能合并分类（负责人专属）");

/* 18a. 公司账户：财务 / 管理员能直接记费用，管理层和员工不行 */
ok(fb.canCo === true, "财务拿到 canCo");
const coOut = await post(finC, "/api/fin/entries", { kind: "out", uid: "__company", ch: "card", date: today,
  amount: 88, cat: "bankfee", ft: "life", note: "银行手续费" });
ok(coOut.status === 201, "财务能把费用记在公司账户上", "status=" + coOut.status);
const coOutRow = coOut.data && coOut.data.id ? db.prepare("SELECT * FROM fin_entries WHERE id=?").get(coOut.data.id) : null;
ok(coOutRow && coOutRow.uid === "__company" && coOutRow.ch === "card", "公司账户费用落在 __company 名下", JSON.stringify(coOutRow && { uid: coOutRow.uid, ch: coOutRow.ch }));
const mgrCo = await post(mgr, "/api/fin/entries", { kind: "out", uid: "__company", ch: "card", date: today,
  amount: 5, cat: "misc", ft: "life", note: "管理层想记公司账户" });
ok(mgrCo.status === 403, "管理层不能直接把费用记到公司账户", "status=" + mgrCo.status);
const staffCo = await post(peter, "/api/fin/entries", { kind: "out", uid: "__company", ch: "card", date: today,
  amount: 3, cat: "misc", ft: "life", note: "员工想记公司账户" });
ok(staffCo.status === 403, "员工不能往公司账户记账", "status=" + staffCo.status);
const peterOwn = await post(peter, "/api/fin/entries", { kind: "out", uid: "peter@ecobox.com", ch: "cash", date: today,
  amount: 2, cat: "misc", ft: "life", note: "彼得自己买水" });
ok(peterOwn.status === 201, "员工记自己的账");
const pOwn = () => db.prepare("SELECT * FROM fin_entries WHERE id=?").get(peterOwn.data.id);
const finTouch = (c, body) => patch(c, "/api/fin/entries/" + peterOwn.data.id, { date: today, cat: "misc", ft: "life", ...body });
ok((await finTouch(finC, { amount: 2, ch: "cash", note: "财务改描述" })).status === 200, "财务能改员工记录的分类 / 描述");
ok(pOwn().amount === 2 && pOwn().note === "财务改描述", "财务改完只有描述变，金额没变");
ok((await finTouch(finC, { amount: 99, ch: "cash", note: "财务改金额" })).status === 403, "财务不能改员工的金额");
ok((await finTouch(finC, { amount: 2, ch: "card", note: "财务改渠道" })).status === 403, "财务不能改员工的收支渠道");
ok(pOwn().amount === 2 && pOwn().ch === "cash", "被拦下后金额和渠道都没动");
ok((await finTouch(mgr, { amount: 99, ch: "cash", note: "负责人改金额" })).status === 403, "负责人不能改员工的金额");
ok((await finTouch(mgr, { amount: 2, ch: "cash", note: "负责人改描述" })).status === 200, "负责人能改员工记录的分类 / 描述");
const peterDel = await post(peter, "/api/fin/entries", { kind: "out", uid: "peter@ecobox.com", ch: "cash", date: today,
  amount: 1, cat: "misc", ft: "life", note: "彼得待删的账" });
ok((await post(boss, "/api/users", { login: "adm2@ecobox.com", name: "副管理员", password: "adm2026x", role: "admin" })).status === 201, "能再开一个管理员");
const adm = client();
ok((await post(adm, "/api/login", { login: "adm2@ecobox.com", password: "adm2026x" })).status === 200, "副管理员能登录");
ok((await finC("/api/fin/entries/" + peterDel.data.id, { method: "DELETE" })).status === 403, "财务不能删员工的记录");
ok((await mgr("/api/fin/entries/" + peterDel.data.id, { method: "DELETE" })).status === 403, "负责人不能删员工的记录");
ok((await adm("/api/fin/entries/" + peterDel.data.id, { method: "DELETE" })).status === 403, "管理员不能删员工的记录");
ok((await finTouch(adm, { amount: 2, ch: "cash", note: "管理员改描述" })).status === 200, "管理员能改员工记录的分类 / 描述");
ok(!!db.prepare("SELECT id FROM fin_entries WHERE id=?").get(peterDel.data.id), "被拒绝删除后记录还在");
ok((await peter("/api/fin/entries/" + peterDel.data.id, { method: "DELETE" })).status === 200, "员工能删自己的记录");
ok((await post(boss, "/api/fin/entries", { kind: "out", uid: "peter@ecobox.com", ch: "cash", date: today,
  amount: 6, cat: "misc", ft: "life", note: "管理员替员工记" })).status === 403, "管理员也不能替别人记账");
ok(!(await peter("/api/fin/bootstrap")).data.entries.some((e) => e.id === coOut.data.id), "员工看不到公司账户的费用");
ok((await peter("/api/fin/bootstrap")).data.canCo !== true, "员工没有公司账户记账权");
ok((await post(boss, "/api/fin/entries", { kind: "out", uid: "__company", ch: "card", date: today,
  amount: 20, cat: "misc", ft: "life", note: "管理员记公司账户" })).status === 201, "管理员也能记公司账户");
ok((await patch(mgr, "/api/fin/entries/" + coOut.data.id, { amount: 99, date: today, note: "管理层改" })).status === 403, "管理层不能改公司账户的记录");
ok((await patch(finC, "/api/fin/entries/" + coOut.data.id, { amount: 90, date: today, note: "财务改" })).status === 200, "财务能改公司账户的记录");
ok((await boss("/api/fin/entries/" + coOut.data.id, { method: "DELETE" })).status === 200, "负责人能删公司账户的记录");

/* 18c. 账目可见范围：管理员 / 财务看全局；负责人看负责人 + 员工；员工只看自己 */
const visEntry = await post(boss, "/api/fin/entries", { kind: "out", uid: "boss@ecobox.com", ch: "cash",
  date: today, amount: 12, cat: "misc", ft: "life", note: "管理员自己花的" });
ok(visEntry.status === 201, "管理员记账", "status=" + visEntry.status);
ok((await finC("/api/fin/bootstrap")).data.entries.some((e) => e.id === visEntry.data.id), "财务看得到管理员的账");
const bossBoot = (await boss("/api/fin/bootstrap")).data;
ok(bossBoot.entries.some((e) => e.id === visEntry.data.id) && bossBoot.entries.some((e) => e.uid === "peter@ecobox.com"), "管理员看全局");
const mgrBoot = (await mgr("/api/fin/bootstrap")).data;
ok(mgrBoot.entries.some((e) => e.uid === "peter@ecobox.com"), "负责人看得到员工的账");
ok(!mgrBoot.entries.some((e) => e.id === visEntry.data.id), "负责人看不到管理员自己的消费");
ok(!mgrBoot.entries.some((e) => e.uid === "fin@ecobox.com"), "负责人看不到财务的账");
ok(!mgrBoot.users.some((u) => u.login === "boss@ecobox.com" || u.login === "fin@ecobox.com"), "负责人的人员列表只有负责人 / 员工");
ok(!mgrBoot.accounts.some((a) => a.uid === "boss@ecobox.com"), "负责人看不到管理员的账户余额");
ok(mgrBoot.canAll === true, "负责人仍有「全部」页签（范围到负责人 / 员工）");
const staffBoot = (await peter("/api/fin/bootstrap")).data;
ok(staffBoot.canAll === false, "员工没有「全部」页签");
ok(!staffBoot.entries.some((e) => e.uid === "lim@ecobox.com"), "员工看不到同事的账");
ok((await patch(mgr, "/api/fin/entries/" + visEntry.data.id, { amount: 1, date: today, note: "管理层想改" })).status === 403, "负责人不能改管理员的账");
ok((await boss("/api/fin/entries/" + visEntry.data.id, { method: "DELETE" })).status === 200, "管理员删掉自己这条测试记录");

/* 18b. 银行水单：上传 / 核对 / 分权 */
const tinyPdf = "data:application/pdf;base64," + Buffer.from("%PDF-1.4\n%test\n").toString("base64");
const noPeriod = await post(boss, "/api/fin/bank", { uid: "__company", open_bal: 1 });
ok(noPeriod.status === 400 && /期间/.test(noPeriod.data.error || ""), "水单没填期间被拒 " + noPeriod.status);
const stmt1 = await post(boss, "/api/fin/bank", {
  uid: "__company", bank: "First Capital Bank", acct_no: "0003203010780", ccy: "ZMW",
  pf: "2026-11-01", pt: "2026-11-12", open_bal: 1000, close_bal: 820, total_in: 0, total_out: 180,
  txs: [
    { d: "2026-11-02", descr: "SAFEEINCOME fee", ref: "S1", debit: 10, credit: 0, bal: 990, cat: "bankfee" },
    { d: "2026-11-05", descr: "PUMA fuel", debit: 170, credit: 0, bal: 820 },
  ],
});
ok(stmt1.status === 201 && /^[0-9a-f]{20}$/.test(stmt1.data.id || ""), "水单能建档 " + JSON.stringify(stmt1.data));
const sid = stmt1.data.id;
ok(stmt1.data.txn_n === 2, "逐笔一起存进去");
const stList = (await boss("/api/fin/bank")).data;
ok(stList.stmts.length === 1 && stList.stmts[0].acct_no === "0003203010780", "列表能看到水单", JSON.stringify(stList.stmts.map((s) => s.acct_no)));
ok(stList.stmts[0].txn_n === 2, "列表带笔数");
const stDetail = (await boss("/api/fin/bank/" + sid)).data;
ok(stDetail.txs.length === 2 && stDetail.txs[0].cat === "bankfee" && stDetail.txs[0].debit === 10, "明细按顺序返回，科目保留", JSON.stringify(stDetail.txs[0]));
ok(stDetail.txs[1].cat === "", "没给科目的先留空（科目建议在浏览器端做，不硬写）", JSON.stringify(stDetail.txs[1]));
const stFile = await post(boss, "/api/fin/bank/" + sid + "/file", { data: tinyPdf, name: "1794510339999.pdf", pages: 3 });
ok(stFile.status === 201 && /^bank\//.test(stFile.data.key || ""), "原件存进 R2 的 bank/ 前缀 " + JSON.stringify(stFile.data));
const stGet = await boss("/api/fin/bank/file/" + sid);
ok(stGet.status === 200 && /pdf/.test(stGet.headers.get("content-type") || ""), "能取回原件");
ok(/inline/.test(stGet.headers.get("content-disposition") || ""), "PDF 走内嵌预览");
const stp = await patch(boss, "/api/fin/bank/" + sid, { status: "checked", note: "对过了" });
ok(stp.status === 200, "能标已核对");
ok((await boss("/api/fin/bank/" + sid)).data.stmt.checked_by === "boss@ecobox.com", "记下核对人");
const txPatch = await patch(boss, "/api/fin/bank/tx/" + stDetail.txs[0].id, { cat: "misc", state: "ignored" });
ok(txPatch.status === 200, "能改单笔科目/状态");
const txAfter = (await boss("/api/fin/bank/" + sid)).data.txs;
ok(txAfter[0].cat === "misc" && txAfter[0].state === "ignored", "单笔改动落库");
ok((await patch(boss, "/api/fin/bank/tx/" + stDetail.txs[1].id, { state: "matched" })).status === 200, "能标单笔已核");
const stK = (await boss("/api/fin/bank")).data.stmts.find((s) => s.id === sid);
ok(stK && stK.ok_n === 1 && stK.txn_n === 2, "列表带已核笔数（人工核对进度）", JSON.stringify(stK && [stK.ok_n, stK.txn_n]));
const stmt2 = await post(boss, "/api/fin/bank", {
  uid: "__company", bank: "First Capital Bank", acct_no: "0003203010780", pf: "2026-11-01", pt: "2026-11-12",
  open_bal: 1000, close_bal: 800, total_out: 200, txs: [{ d: "2026-11-03", descr: "fix", debit: 200, bal: 800 }],
});
ok(stmt2.status === 201 && stmt2.data.id !== sid, "同期间重传另开一条");
const stAll = (await boss("/api/fin/bank")).data.stmts;
ok(stAll.filter((s) => s.pf === "2026-11-01").every((s) => s.old === (s.id === sid ? 1 : 0)), "旧版本标记 old=1，两条都留着", JSON.stringify(stAll.map((s) => [s.id === sid, s.old])));
ok((await post(finC, "/api/fin/bank", { uid: "__company", pf: "2026-11-01", pt: "2026-11-12" })).status === 201, "财务也能上传");
ok((await post(peter, "/api/fin/bank", { uid: "__company", pf: "2026-11-01", pt: "2026-11-12" })).status === 403, "普通员工不能上传水单");
ok((await post(peter, "/api/fin/bank", { pf: "2026-09-01", pt: "2026-09-30", open_bal: 100, close_bal: 100 })).status === 201, "员工能上传自己名下的水单");
ok((await peter("/api/fin/bank/" + sid)).status === 403, "普通员工看不到公司的水单");
ok(!(await peter("/api/fin/bootstrap")).data.bankAll, "员工的 bootstrap 里 bankAll=false");
const myStmt = await post(boss, "/api/fin/bank", { uid: "peter@ecobox.com", pf: "2026-10-01", pt: "2026-10-31", open_bal: 5, close_bal: 5 });
const peterList = (await peter("/api/fin/bank")).data;
ok(myStmt.status === 201 && peterList.stmts.length === 2 && peterList.stmts.every((s) => s.uid === "peter@ecobox.com"), "员工只看得到自己名下的水单", JSON.stringify(peterList.stmts.map((s) => s.uid)));
ok((await peter("/api/fin/bank/" + myStmt.data.id)).status === 200, "员工能看自己的水单");
ok((await patch(peter, "/api/fin/bank/" + myStmt.data.id, { status: "checked" })).status === 403, "员工不能自己标核对");
ok((await peter("/api/fin/bank/" + myStmt.data.id, { method: "DELETE" })).status === 403, "员工不能删自己的水单");
const stDel = await boss("/api/fin/bank/" + sid, { method: "DELETE" });
ok(stDel.status === 200, "能删水单");
ok(!(await boss("/api/fin/bank")).data.stmts.some((s) => s.id === sid), "删完不在列表");
ok((await boss("/api/fin/bank/" + sid)).status === 404, "删完详情 404");
ok((await boss("/api/fin/bank/file/" + sid)).status === 404, "删完原件也取不到");

/* 语言设置 + 双语内容 */
ok((await boss("/api/modules")).data.modules.some((m) => m.k === "lang" && m.t === "语言"), "系统里有「语言」模块");
const bankMod = (await boss("/api/modules")).data.modules.find((m) => m.k === "bank");
ok(bankMod && bankMod.g === "财务" && bankMod.tab === "bank" && bankMod.d_en, "「银行账单」是财务组里的独立模块", JSON.stringify(bankMod));
ok((await patch(boss, "/api/me", { lang: "en" })).data.user.lang === "en", "能切成英文");
ok((await boss("/api/me")).data.user.lang === "en", "语言跟着账号走");
ok((await patch(boss, "/api/me", { lang: "fr" })).status === 400, "只认 zh / en");
await patch(boss, "/api/me", { lang: "zh" });

/* 快捷（置顶） */
ok(Array.isArray((await boss("/api/me")).data.user.shortcuts), "新账号默认没有快捷");
const spin = await patch(boss, "/api/me", { shortcuts: ["log", "finance"] });
ok(spin.status === 200 && spin.data.user.shortcuts.join(",") === "log,finance", "能设快捷，顺序保留");
ok((await boss("/api/me")).data.user.shortcuts.join(",") === "log,finance", "快捷存在账号上");
ok((await patch(boss, "/api/me", { shortcuts: ["nope", "log", "log", "finance"] })).data.user.shortcuts.join(",") === "log,finance", "非法键、重复项被丢掉");
ok((await patch(boss, "/api/me", { shortcuts: "log" })).status === 400, "快捷必须是数组");
await patch(boss, "/api/me", { shortcuts: [] });

const fp = await post(boss, "/api/feed", { body: "今天下雨" });
ok(fp.status === 201, "发一条动态");
const fd = (await boss("/api/feed")).data.posts.find((x) => x.id === fp.data.id);
ok(fd && fd.body_zh === "今天下雨", "中文原文存进 body_zh");
const fc = await post(boss, "/api/feed/" + fp.data.id + "/comment", { text: "路不好走" });
ok(fc.status === 200 && fc.data.comments[0].text_zh === "路不好走", "留言原文存进 text_zh");
ok(!fc.data.comments[0].text_en, "没配 AI key 时不写空译文");
const nl = await post(boss, "/api/logs", { day: "2026-09-30", site: "Serenje 1330NW", note: "换筛网" });
const nlRow = (await boss("/api/logs?from=2026-09-30&to=2026-09-30")).data.logs.find((x) => x.id === nl.data.id);
ok(!!nlRow && nlRow.note_zh === "换筛网", "日报备注也是双语");
const fe = await post(boss, "/api/fin/entries", { uid: (await boss("/api/me")).data.user.login, date: "2026-09-30", kind: "out", cat: "fuel", ft: "life", ch: "cash", amount: 10, note: "买柴油" });
const feRow = (await boss("/api/fin/bootstrap")).data.entries.find((x) => x.id === fe.data.id);
ok(!!feRow && feRow.note_zh === "买柴油", "账目备注也是双语");

/* 17. 待办：自己记 / 派活 / 公司事项跟评 */
const tdAnon = client();
await post(boss, "/api/users", { login: "td@ecobox.com", name: "待办同事", password: "tdpass2026", role: "staff" });
const tdStaff = client();
ok((await post(tdStaff, "/api/login", { login: "td@ecobox.com", password: "tdpass2026" })).status === 200, "待办测试用的员工能登录");
ok((await tdAnon("/api/todos")).status === 401, "未登录读不到待办");
ok((await tdAnon("/api/people")).status === 401, "未登录读不到同事名单");
const ppl = await tdStaff("/api/people");
ok(ppl.status === 200 && ppl.data.people.some((p) => p.login === "td@ecobox.com"), "同事名单含自己");
ok(ppl.data.people.every((p) => !("pwd_hash" in p) && !("password" in p)), "同事名单不泄露密码");

const tdMine = await post(boss, "/api/todos", { title: "核对 1330NW 取样照片", scope: "self", due: "2026-11-20" });
ok(tdMine.status === 201 && tdMine.data.id, "能建自己的待办");
ok((await post(boss, "/api/todos", { title: "  ", scope: "self" })).status === 400, "空标题被拦下");
ok((await post(boss, "/api/todos", { title: "x", scope: "person", owner: "nobody@x.com" })).status === 404, "指派给不存在的人 404");
ok((await post(boss, "/api/todos", { title: "x", scope: "self", due: "11/20" })).status === 400, "截止日期格式错被拦下");

const tdGive = await post(boss, "/api/todos", { title: "把照片传完", scope: "person", owner: "td@ecobox.com", due: "2026-11-05", imp: 1 });
ok(tdGive.status === 201, "能把活儿派给同事");
const tdCo = await post(boss, "/api/todos", { title: "本月报税材料交给会计", scope: "company", note: "要发票扫描件" });
ok(tdCo.status === 201, "能发公司事项（不指定人）");

const list1 = await tdStaff("/api/todos");
ok(list1.status === 200 && list1.data.todos.length === 3, "员工看得到全部待办", JSON.stringify(list1.data.todos && list1.data.todos.length));
const g = list1.data.todos.find((t) => t.id === tdGive.data.id);
ok(g && g.owner === "td@ecobox.com" && g.owner_name === "待办同事" && g.imp === 1, "指派的执行人和姓名落库");
ok(list1.data.todos.find((t) => t.id === tdCo.data.id).owner === "", "公司事项可以没有执行人");
const mineRow = list1.data.todos.find((t) => t.id === tdMine.data.id);
ok(mineRow.owner === "boss@ecobox.com" && mineRow.scope === "self", "自己的待办执行人是自己");

ok((await patch(tdStaff, "/api/todos/" + tdMine.data.id, { status: "done" })).status === 403, "员工不能关别人的待办");
/* 指派即归属：不等对方点「开始执行」，派下去就是进行中，就归他 */
const assignRow = list1.data.todos.find((t) => t.id === tdGive.data.id);
ok(assignRow.status === "doing", "派下去就是进行中（不用等对方点开始）");
ok(!!assignRow.assign_at && !!assignRow.started_at, "派下去就记下归属时间");
ok(assignRow.notes.some((n) => n.kind === "assign" && n.body.includes("待办同事")), "时间线记下「指派给谁」");
ok(assignRow.self_set === 0, "派给别人的不算自派");
ok(mineRow.self_set === 1, "自己给自己排的标成自派");

/* 每日汇报：派给谁就由谁报，别人只能留言；一键「今天没动」不用打字 */
ok((await post(boss, "/api/todos/" + tdGive.data.id + "/start", { text: "我来看看" })).status === 403, "不是归属人不能汇报");
const rep1 = await post(tdStaff, "/api/todos/" + tdGive.data.id + "/report", { text: "今天导出了 3 个点的照片，还剩 2 个", flag: "progress" });
ok(rep1.status === 200 && rep1.data.reported === true, "归属人能汇报");
const reported = (await tdStaff("/api/todos")).data.todos.find((t) => t.id === tdGive.data.id);
ok(/^\d{4}-\d{2}-\d{2}/.test(reported.last_report_at), "汇报后记下最近汇报日期");
ok(reported.last_report_by === "td@ecobox.com" && reported.last_flag === "progress", "汇报人和标记落库");
const repNote = reported.notes.filter((n) => n.kind === "report").pop();
ok(!!repNote && repNote.flag === "progress" && repNote.body.includes("还剩 2 个") && repNote.name === "待办同事", "汇报留下带时间的记录");
ok((await post(tdStaff, "/api/todos/" + tdGive.data.id + "/report", { flag: "idle" })).status === 200, "一键「今天没动」也能汇报");
const idleRow = (await tdStaff("/api/todos")).data.todos.find((t) => t.id === tdGive.data.id);
ok(idleRow.last_flag === "idle" && idleRow.notes.some((n) => n.flag === "idle" && n.body === "今天没动"), "一键汇报自动补正文");
ok(idleRow.status === "doing" && idleRow.owner === "td@ecobox.com", "汇报不会改状态、更不会改归属");

/* 改派：人换了，汇报记录从零开始，别拿上一个人的充数 */
ok((await patch(boss, "/api/todos/" + tdGive.data.id, { owner: "boss@ecobox.com" })).status === 200, "发起人能改派");
const movedRow = (await boss("/api/todos")).data.todos.find((t) => t.id === tdGive.data.id);
ok(movedRow.owner === "boss@ecobox.com" && movedRow.last_report_at === "" && movedRow.last_flag === "", "改派后汇报清零");
ok(movedRow.notes.some((n) => n.body.includes("改派给")), "时间线记下改派");
ok((await post(tdStaff, "/api/todos/" + tdGive.data.id + "/report", { text: "还想报" })).status === 403, "改派后原执行人不能再汇报");
ok((await patch(boss, "/api/todos/" + tdGive.data.id, { owner: "td@ecobox.com" })).status === 200, "能改派回去");

/* 完成闭环：执行人提交申请 → 派活人审核 → 通过才算完成；驳回回到进行中继续做 */
ok((await patch(tdStaff, "/api/todos/" + tdGive.data.id, { status: "done" })).status === 403, "执行人不能自己按完成，只能提交申请");
const sub1 = await post(tdStaff, "/api/todos/" + tdGive.data.id + "/submit", { note: "照片全部传完，已放 R2" });
ok(sub1.status === 200 && sub1.data.status === "submitted", "执行人能提交完成申请");
const subRow = (await boss("/api/todos")).data.todos.find((t) => t.id === tdGive.data.id);
ok(subRow.status === "submitted" && subRow.submit_by === "td@ecobox.com" && subRow.rounds === 1, "提交人、轮次落库");
ok(subRow.notes.some((n) => n.kind === "submit" && n.body.includes("R2")), "时间线记下提交申请");
ok((await post(tdStaff, "/api/todos/" + tdGive.data.id + "/submit", {})).status === 409, "不能重复提交");
ok((await post(tdStaff, "/api/todos/" + tdGive.data.id + "/report", { text: "再报一次" })).status === 400, "已提交期间不再收日报");
ok((await post(tdStaff, "/api/todos/" + tdGive.data.id + "/review", { pass: true })).status === 403, "执行人不能自己审核通过");
ok((await patch(tdStaff, "/api/todos/" + tdGive.data.id, { status: "done" })).status === 403, "已提交后执行人也不能绕过审核自己改成完成");
const stillSub = (await boss("/api/todos")).data.todos.find((t) => t.id === tdGive.data.id);
ok(stillSub.status === "submitted" && stillSub.review_result === "", "绕过审核被拒后仍是待审核");
ok((await post(boss, "/api/todos/" + tdGive.data.id + "/review", { pass: false })).status === 400, "驳回必须写原因");
const rej = await post(boss, "/api/todos/" + tdGive.data.id + "/review", { pass: false, note: "Chitambo 还剩 2 个点没传" });
ok(rej.status === 200 && rej.data.status === "doing", "驳回后回到进行中");
const rejRow = (await boss("/api/todos")).data.todos.find((t) => t.id === tdGive.data.id);
ok(rejRow.review_result === "reject" && rejRow.submit_at === "" && rejRow.status === "doing", "驳回清掉待审状态");
ok(rejRow.notes.some((n) => n.kind === "review" && n.body.includes("Chitambo")), "驳回意见留在时间线");
ok((await post(tdStaff, "/api/todos/" + tdGive.data.id + "/submit", { note: "补完了" })).status === 200, "改完能再提交");
const okPass = await post(boss, "/api/todos/" + tdGive.data.id + "/review", { pass: true, note: "验收通过" });
ok(okPass.status === 200 && okPass.data.status === "done", "派活人审核通过才算完成");
const finished = (await tdStaff("/api/todos")).data.todos.find((t) => t.id === tdGive.data.id);
ok(finished.status === "done" && !!finished.done_at, "完成时间落库");
ok(finished.review_result === "pass" && finished.review_by === "boss@ecobox.com" && finished.rounds === 2, "审核人、轮次落库");
ok(finished.notes.some((n) => n.kind === "review" && n.body === "验收通过"), "审核意见留在时间线");
ok((await post(tdStaff, "/api/todos/" + tdGive.data.id + "/report", { text: "完成后又说一句" })).status === 400, "完成了不能再汇报");
ok((await patch(tdStaff, "/api/todos/" + tdGive.data.id, { status: "todo" })).status === 200, "能重新打开（老写法 todo 也当进行中）");
const reopened = (await tdStaff("/api/todos")).data.todos.find((t) => t.id === tdGive.data.id);
ok(reopened.status === "doing" && reopened.done_at === "", "重开后是进行中，完成时间清掉");

/* 公司事项没有归属人：谁都能跟一句，但不算某人汇报、也不改归属（不许「谁点谁得」） */
const coRep = await post(tdStaff, "/api/todos/" + tdCo.data.id + "/report", { text: "我先去对发票" });
ok(coRep.status === 200 && coRep.data.reported === false, "公司事项谁都能跟一句");
const coFollow = (await boss("/api/todos")).data.todos.find((t) => t.id === tdCo.data.id);
ok(coFollow.owner === "" && coFollow.last_report_at === "", "跟一句不会变成「谁点谁得」");

ok((await post(tdStaff, "/api/todos/" + tdCo.data.id + "/submit", {})).status === 403, "公司事项没指派时员工不能替所有人提交");
const cmt = await post(tdStaff, "/api/todos/" + tdCo.data.id + "/notes", { text: "会计周五来取" });
ok(cmt.status === 201, "公司事项能留言跟踪");
const withCmt = (await boss("/api/todos")).data.todos.find((t) => t.id === tdCo.data.id);
ok(withCmt.notes.some((n) => n.body === "会计周五来取" && n.name === "待办同事" && n.kind === "cmt"), "留言带姓名落库");
ok((await post(tdStaff, "/api/todos/" + tdCo.data.id + "/notes", { text: "   " })).status === 400, "空留言被拦下");
ok((await post(tdStaff, "/api/todos/" + tdCo.data.id + "/notes", { text: "x".repeat(1200) })).status === 201, "超长留言截断后能存");
/* 回复某条留言：挂 reply_to，串到别的待办就当普通留言 */
const anchor = (await boss("/api/todos")).data.todos.find((t) => t.id === tdCo.data.id).notes[0].id;
const reply1 = await post(tdStaff, "/api/todos/" + tdCo.data.id + "/notes", { text: "周三我去取", reply_to: anchor });
ok(reply1.status === 201, "能回复某条留言");
const thread = (await boss("/api/todos")).data.todos.find((t) => t.id === tdCo.data.id);
ok(thread.notes.some((n) => n.body === "周三我去取" && n.reply_to === anchor), "回复挂在原留言下");
const badReply = await post(tdStaff, "/api/todos/" + tdCo.data.id + "/notes", { text: "引用不存在", reply_to: "nope" });
ok(badReply.status === 201 && (await boss("/api/todos")).data.todos.find((t) => t.id === tdCo.data.id).notes.every((n) => n.body !== "引用不存在" || n.reply_to === ""), "引用不存在就当普通留言");

ok((await patch(boss, "/api/todos/" + tdCo.data.id, { title: "本月报税材料交给会计（含发票）" })).status === 200, "发起人能改标题");
ok((await patch(boss, "/api/todos/" + tdCo.data.id, { status: "done" })).status === 200, "发起人能改状态");
ok((await patch(boss, "/api/todos/" + tdCo.data.id, { status: "todo" })).status === 200, "再改回来");

/* 派活/改派只给管理层：前端收口了，直接打接口也要拦住 */
const staffAssign = await post(tdStaff, "/api/todos", { title: "替老板派个活", scope: "person", owner: "boss@ecobox.com" });
ok(staffAssign.status === 403, "员工不能派活给同事");
const staffMove = await patch(tdStaff, "/api/todos/" + tdGive.data.id, { owner: "boss@ecobox.com" });
ok(staffMove.status === 403, "员工不能把自己的活甩给别人");
const staffSelf = await post(tdStaff, "/api/todos", { title: "今天先核 3 个点的坐标", due: "" });
ok(staffSelf.status === 201, "员工能给自己排今天的活");
const staffSelfRow = (await tdStaff("/api/todos")).data.todos.find((t) => t.id === staffSelf.data.id);
ok(staffSelfRow.owner === "td@ecobox.com" && staffSelfRow.self_set === 1 && staffSelfRow.scope === "self", "自己排的活归自己");
ok(staffSelfRow.status === "doing" && !!staffSelfRow.assign_at, "建好就是进行中，不用再点开始");
ok(staffSelfRow.notes.some((n) => n.kind === "assign" && n.body === "自己给自己排的任务"), "时间线写清是自己给自己排的");
const selfDone = await post(tdStaff, "/api/todos/" + staffSelf.data.id + "/submit", { note: "核完了" });
ok(selfDone.status === 200 && selfDone.data.status === "done" && selfDone.data.self === true, "自己排的活提交即完成，不用自己审自己");
const selfDoneRow = (await tdStaff("/api/todos")).data.todos.find((t) => t.id === staffSelf.data.id);
ok(selfDoneRow.review_result === "pass" && selfDoneRow.rounds === 1, "自派任务也记一轮审核");
ok((await tdStaff("/api/todos/" + tdGive.data.id, { method: "DELETE" })).status === 403, "员工不能删别人的待办");
ok((await boss("/api/todos/" + tdMine.data.id, { method: "DELETE" })).status === 200, "发起人能删自己的待办");
ok(!(await boss("/api/todos")).data.todos.some((t) => t.id === tdMine.data.id), "删掉的待办不再返回");
ok((await patch(boss, "/api/todos/nope", { title: "x" })).status === 404, "改不存在的待办 404");
/* 附件：每项待办都能挂文件（PDF / 图片 / Office / 文本 / ZIP），实体在 R2 */
const PDFDATA = "data:application/pdf;base64," + Buffer.from("%PDF-1.4 test").toString("base64");
const up1 = await post(boss, "/api/todos/" + tdCo.data.id + "/file", { data: PDFDATA, name: "报税发票.pdf" });
ok(up1.status === 201 && up1.data.files.length === 1, "能给待办加附件");
ok(up1.data.file.key.startsWith("todo/" + tdCo.data.id + "/") && /\.pdf$/.test(up1.data.file.key), "附件按 todo/<id>/ 存 R2");
ok(up1.data.files[0].name === "报税发票.pdf" && up1.data.files[0].size === 13 && up1.data.files[0].by_login === "boss@ecobox.com", "附件带名称/大小/上传人");
const withFile = (await boss("/api/todos")).data.todos.find((t) => t.id === tdCo.data.id);
ok(withFile.files.length === 1 && withFile.files[0].k === up1.data.file.k, "列表带回附件清单");
const dl1 = await boss("/api/todos/" + tdCo.data.id + "/file/" + up1.data.file.k);
ok(dl1.status === 200 && String(dl1.data).includes("%PDF-1.4 test"), "能下载附件原文件");
ok(/inline/.test(dl1.headers.get("content-disposition") || ""), "PDF 走内嵌预览");
const up2 = await post(tdStaff, "/api/todos/" + tdCo.data.id + "/file", { data: "data:text/csv;base64," + Buffer.from("a,b\n1,2").toString("base64"), name: "品位.csv" });
ok(up2.status === 201 && up2.data.files.length === 2, "公司事项谁都能补附件");
const dl2 = await boss("/api/todos/" + tdCo.data.id + "/file/" + up2.data.file.k);
ok(/attachment/.test(dl2.headers.get("content-disposition") || ""), "CSV 等走下载，不在本域内嵌");
ok((await post(boss, "/api/todos/" + tdCo.data.id + "/file", { data: "data:text/html;base64," + Buffer.from("<b>x</b>").toString("base64"), name: "x.html" })).status === 400, "HTML 附件被拒");
ok((await post(boss, "/api/todos/" + tdCo.data.id + "/file", { data: "nope" })).status === 400, "不是 dataURL 被拦下");
const bigRes = await post(boss, "/api/todos/" + tdCo.data.id + "/file", { data: "data:application/pdf;base64," + "A".repeat(34 * 1024 * 1024), name: "huge.pdf" });
ok(bigRes.status === 400 && /线下提供/.test(bigRes.data.error || ""), "超过 25MB 提示线下提供 " + bigRes.status);
ok((await boss("/api/todos/" + tdCo.data.id + "/file/nofile")).status === 404, "不存在的附件 404");
/* 附件也认人：不相干的员工只能看，不能改 */
await post(boss, "/api/users", { login: "out@ecobox.com", name: "外人", password: "outpass2026", role: "staff" });
const outStaff = client();
await post(outStaff, "/api/login", { login: "out@ecobox.com", password: "outpass2026" });
ok((await outStaff("/api/todos/" + tdCo.data.id + "/file/" + up1.data.file.k)).status === 200, "同事能看到附件");
ok((await post(outStaff, "/api/todos/" + tdGive.data.id + "/file", { data: PDFDATA, name: "x.pdf" })).status === 403, "无关员工不能给别人派下的活加附件");
ok((await outStaff("/api/todos/" + tdGive.data.id + "/file/" + up1.data.file.k, { method: "DELETE" })).status === 403, "无关员工不能删附件");
const delF = await boss("/api/todos/" + tdCo.data.id + "/file/" + up2.data.file.k, { method: "DELETE" });
ok(delF.status === 200 && delF.data.files.length === 1, "能删附件");
ok(!R2.has(up2.data.file.key), "删附件同时清掉 R2 对象");
const afterDel = (await boss("/api/todos")).data.todos.find((t) => t.id === tdCo.data.id);
ok(afterDel.files.length === 1 && afterDel.files[0].k === up1.data.file.k, "删掉的附件不再返回");

const mods = (await boss("/api/modules")).data.modules;
const todoMod = mods.find((m) => m.k === "todo");
ok(todoMod && todoMod.tab === "todo" && !todoMod.soon, "待办模块已开通（不是待开放）");

/* 15. 账号名是账目/账户/待办的关联键：改名必须把历史一起搬走，否则「我的」变空白 */
const renU = await post(boss, "/api/users", { login: "ren@ecobox.com", name: "改名的人", password: "ren2026pass", role: "staff" });
ok(renU.status === 201, "开一个用来改名的账号");
const renc = client();
await post(renc, "/api/login", { login: "ren@ecobox.com", password: "ren2026pass" });
ok((await post(renc, "/api/fin/entries", { kind: "out", uid: "ren@ecobox.com", amount: 88, date: today,
  note: "改名前的账", cat: "misc", ft: "life", ch: "cash" })).status === 201, "改名之前先记一笔");
await putAcct(boss, "ren@ecobox.com", { name: "改名的人", cash: 500, card: 0 });
const rn = await patch(boss, "/api/users/" + renU.data.id, { login: "ren2@ecobox.com" });
ok(rn.status === 200, "管理员能改账号名");
ok(rn.data.moved && rn.data.moved.entries === 1, "改名时把账目一起搬走（moved=" + JSON.stringify(rn.data.moved) + "）");
ok(db.prepare("SELECT COUNT(*) c FROM fin_entries WHERE uid='ren@ecobox.com'").get().c === 0, "旧账号名下不留记录");
ok(db.prepare("SELECT COUNT(*) c FROM fin_entries WHERE uid='ren2@ecobox.com' AND note='改名前的账'").get().c === 1, "记录挂到新账号名下");
ok(!!db.prepare("SELECT uid FROM fin_accounts WHERE uid='ren2@ecobox.com'").get(), "账户余额也跟到新账号");
ok(!db.prepare("SELECT uid FROM fin_accounts WHERE uid='ren@ecobox.com'").get(), "旧账户不留空壳");
const renc2 = client();
await post(renc2, "/api/login", { login: "ren2@ecobox.com", password: "ren2026pass" });
const renBs = (await renc2("/api/fin/bootstrap")).data;
ok(renBs.entries.some((e) => e.note === "改名前的账"), "改名后「我的」里还看得到旧账");
ok(renBs.orphans.length === 0, "改名后没有孤儿记录");

/* 16. 历史事故兜底：记录挂在已经不存在的账号名下时，bootstrap 要报出来，管理员能一键合并 */
db.prepare("INSERT INTO fin_entries(id,uid,by_name,date,kind,cat,ft,ch,amount,note,photos,to_uid,to_ch,inv,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .run("orph1", "ghost@old.com", "Ghost", today, "out", "misc", "life", "cash", 66, "历史记录", "[]", "", "", 0, "2026-01-01T00:00:00Z");
const bossBs = (await boss("/api/fin/bootstrap")).data;
ok((bossBs.orphans || []).some((o) => o.uid === "ghost@old.com" && o.n === 1), "bootstrap 报出挂在旧账号下的记录",
  JSON.stringify(bossBs.orphans));
const enemyBs = (await limc("/api/fin/bootstrap")).data;
ok((enemyBs.orphans || []).length === 0, "只看自己账本的人不会看到孤儿提示");
ok((await post(peter, "/api/fin/remap", { from: "ghost@old.com", to: "peter@ecobox.com" })).status === 403, "员工不能合并旧账号");
const rm = await post(boss, "/api/fin/remap", { from: "ghost@old.com", to: "boss@ecobox.com" });
ok(rm.status === 200 && rm.data.moved.entries === 1, "管理员能把旧账号的记录并过来");
ok(!db.prepare("SELECT id FROM fin_entries WHERE uid='ghost@old.com'").get(), "旧账号名下的记录搬空了");
ok((await boss("/api/fin/bootstrap")).data.orphans.length === 0, "合并后不再提示");

/* 矿证：矿权申请助手（/licence.html + /lic/*） */
const nore = client();
const anonymous2 = client();
ok((await nore("/licence.html", { redirect: "manual" })).status === 302, "未登录访问矿证被踢回工作台");
ok((await post(nore, "/lic/", { action: "read" })).status === 401, "未登录不能读矿证");
ok((await nore("/lic/media?key=lic/x.pdf")).status === 401, "未登录不能取矿证文件");
const licRead0 = await post(boss, "/lic/", { action: "read" });
ok(licRead0.status === 200 && licRead0.data.ok === true, "矿证能读状态");
const licState = JSON.stringify({ v: 1, companies: [], apps: [], updatedAt: "2026-01-01T00:00:00.000Z" });
ok((await post(boss, "/lic/", { action: "save", content: licState })).status === 200, "矿证能存状态");
const licRead1 = await post(boss, "/lic/", { action: "read" });
ok(JSON.parse(licRead1.data.content).updatedAt === "2026-01-01T00:00:00.000Z", "矿证存进去能读回来");
ok((await post(boss, "/lic/", { action: "save", content: "nope" })).status === 400, "矿证拒非法 JSON");
ok((await post(boss, "/lic/", { action: "nope" })).status === 400, "矿证拒未知操作");
ok((await boss("/lic/media?key=etc/passwd")).status === 400, "矿证只放行 lic/ company/ 前缀");
const lfd = new FormData();
lfd.append("file", new Blob([Buffer.from("%PDF-1.4 test")], { type: "application/pdf" }), "证书.pdf");
const licUp = await boss("/lic/upload", { method: "POST", form: lfd });
ok(licUp.status === 200 && licUp.data.ok && /^lic\/.+\.pdf$/.test(licUp.data.key), "矿证能传文件 " + JSON.stringify(licUp.data).slice(0, 120));
ok(R2.has(licUp.data.key), "矿证文件真的进了对象存储");
ok((await boss("/lic/media?key=" + encodeURIComponent(licUp.data.key))).status === 200, "矿证文件能取回");
ok(R2.get(licUp.data.key).mime === "application/pdf", "矿证文件带 mime");

/* 打卡：GPS 围栏 + 两段打卡 + 月度统计 */
ok((await boss("/api/att?ym=2026-01&d=2026-01-05")).status === 200, "打卡能读状态");
ok((await post(anonymous2, "/api/att/cfg", { lat: -15.4, lng: 28.3 })).status === 401, "未登录不能改打卡设置");
ok((await post(boss, "/api/att/cfg", { lat: -15.4, lng: 28.3, radius: 300, start: "08:00", end: "17:00", grace: 15 })).status === 200, "管理员能设打卡点");
const punch1 = await post(boss, "/api/att/punch", { lat: -15.4, lng: 28.3, d: "2026-01-05", hm: "07:55", acc: 8 });
ok(punch1.status === 200 && punch1.data.phase === "in" && punch1.data.dist === 0, "上班打卡成功 " + JSON.stringify(punch1.data).slice(0, 120));
ok((await post(boss, "/api/att/punch", { lat: -15.4, lng: 28.3, d: "2026-01-05", hm: "07:56" })).status === 409, "1 分钟内下班打卡被拦");
db.prepare("UPDATE attendance SET in_at=? WHERE uid=? AND d=?").run(new Date(Date.now() - 9 * 3600e3).toISOString(), "boss@ecobox.com", "2026-01-05");
const punch2 = await post(boss, "/api/att/punch", { lat: -15.4, lng: 28.3, d: "2026-01-05", hm: "17:05" });
ok(punch2.status === 200 && punch2.data.phase === "out", "下班打卡成功");
ok((await post(boss, "/api/att/punch", { lat: -15.4, lng: 28.3, d: "2026-01-05", hm: "17:06" })).status === 409, "当天打满两段后再打被拦");
const farPunch = await post(boss, "/api/att/punch", { lat: -15.5, lng: 28.3, d: "2026-01-06", hm: "08:01" });
ok(farPunch.status === 409 && /不在公司范围/.test(farPunch.data.error), "超出范围被拒 " + JSON.stringify(farPunch.data));
const attState = await boss("/api/att?ym=2026-01&d=2026-01-05");
ok(attState.data.stats.days === 1 && attState.data.stats.late === 0, "本月统计出勤 1 天不迟到 " + JSON.stringify(attState.data.stats));
ok(attState.data.records.length === 1 && attState.data.records[0].outHm === "17:05", "打卡记录带上下班时间");
ok((await post(boss, "/api/att/cfg", { lat: 999, lng: 0 })).status === 400, "坏坐标被拒");

/* 客户 */
const cuNew = await post(boss, "/api/customers", { name: "Lusaka Buyers Ltd", contact: "Mr Banda", phone: "+260 97 000", country: "Zambia", currency: "USD", accNo: "123456" });
ok(cuNew.status === 201 && cuNew.data.id, "能建客户");
const cuId = cuNew.data.id;
ok((await post(boss, "/api/customers", { name: "  " })).status === 400, "客户名必填");
const cuList = await boss("/api/customers?q=banda");
ok(cuList.data.customers.length === 1 && cuList.data.customers[0].id === cuId, "能按联系人搜索");
const cuPatch = await patch(boss, "/api/customers/" + cuId, { phone: "+260 96 111", note: "长期" });
ok(cuPatch.status === 200 && cuPatch.data.customer.phone === "+260 96 111", "能改客户");
ok(cuPatch.data.customer.accNo === "123456", "改电话不会把账号清空");
ok((await boss("/api/customers/cu-none")).status === 404, "改不存在的客户 404");
ok((await boss("/api/customers/" + cuId, { method: "DELETE" })).status === 200, "能删客户");
ok((await boss("/api/customers")).data.total === 0, "删完列表清空");

/* 出口：7 段流程 + 文件 */
const exNew = await post(boss, "/api/exports", { date: "2026-01-06", co: "EcoBox Mining", mineral: "Tantalum", qty: 20, unit: "t", importer: "Kemet", dest: "China" });
ok(exNew.status === 201 && exNew.data.id, "能建出口单");
const exId = exNew.data.id;
const exList = await boss("/api/exports");
ok(exList.data.total === 1 && exList.data.stages.length === 7, "出口单列出且带 7 段流程");
const st1 = await post(boss, "/api/exports/" + exId + "/stage", { stage: "moses", fields: { ref: "MOSES-771" } });
ok(st1.status === 200 && st1.data.export.status === "moses", "能推进到 MOSES 阶段");
ok(st1.data.export.stages.moses.ref === "MOSES-771", "阶段字段落库");
ok((await post(boss, "/api/exports/" + exId + "/stage", { stage: "bogus" })).status === 400, "未知阶段被拒");
const exUp = await post(boss, "/api/exports/" + exId + "/file", { stage: "moses", name: "moses.pdf", data: "data:application/pdf;base64," + Buffer.from("%PDF-1.4 x").toString("base64") });
ok(exUp.status === 201 && exUp.data.files.length === 1, "能上传阶段文件");
ok(R2.has(exUp.data.file.key) && exUp.data.file.key.startsWith("export/" + exId + "/moses/"), "文件落在 export/<id>/<stage>/");
const exGetFile = await boss("/api/exports/" + exId + "/file?k=" + encodeURIComponent(exUp.data.file.k));
ok(exGetFile.status === 200, "能取回阶段文件");
ok((await boss("/api/exports/" + exId + "/file?k=nope")).status === 404, "不存在的文件 404");
ok((await boss("/api/exports/" + exId)).data.export.files.length === 1, "详情里能看到文件");
ok((await boss("/api/exports/" + exId + "/file?k=" + encodeURIComponent(exUp.data.file.k), { method: "DELETE" })).status === 200, "能删阶段文件");
ok(!R2.has(exUp.data.file.key), "删文件时对象存储也清了");
const exDel = await boss("/api/exports/" + exId, { method: "DELETE" });
ok(exDel.status === 200 && (await boss("/api/exports")).data.total === 0, "能删出口单");

/* 11. 登录限速：同账号 + 同 IP，10 分钟内错 5 次锁 10 分钟，成功即清零 */
await post(boss, "/api/users", { login: "rl@ecobox.com", name: "限速测试", password: "rlpass2026", role: "staff" });
const ipA = { "cf-connecting-ip": "10.9.9.1" };
const rl = client();
for (let i = 1; i <= 5; i++) {
  const r = await post(rl, "/api/login", { login: "rl@ecobox.com", password: "bad-pass-" + i }, ipA);
  ok(r.status === 401, "限速：第 " + i + " 次错密码仍是 401，得到 " + r.status);
}
const locked = await post(rl, "/api/login", { login: "rl@ecobox.com", password: "rlpass2026" }, ipA);
ok(locked.status === 429, "限速：第 6 次即使密码正确也被锁，得到 " + locked.status);
const retry = Number(locked.headers.get("retry-after"));
ok(retry > 0 && retry <= 600, "限速：retry-after 在 1..600 秒之间，得到 " + retry);
ok(/尝试次数过多/.test(locked.data.error || ""), "限速：提示文案 " + (locked.data.error || ""));

ok((await post(client(), "/api/login", { login: "RL@ecobox.com", password: "rlpass2026" }, { "cf-connecting-ip": "10.9.9.2" })).status === 200, "限速：按账号+IP 隔离，换 IP 能登录");
ok((await post(client(), "/api/login", { login: "boss@ecobox.com", password: "ecobox2026" }, ipA)).status === 200, "限速：不影响同 IP 的其他账号");

const ipB = { "cf-connecting-ip": "10.9.9.3" };
for (let i = 0; i < 4; i++) await post(client(), "/api/login", { login: "rl@ecobox.com", password: "nope" + i }, ipB);
ok((await post(client(), "/api/login", { login: "rl@ecobox.com", password: "rlpass2026" }, ipB)).status === 200, "限速：4 次失败后仍能正常登录");
await post(client(), "/api/login", { login: "rl@ecobox.com", password: "nope-again" }, ipB);
ok((await post(client(), "/api/login", { login: "rl@ecobox.com", password: "rlpass2026" }, ipB)).status === 200, "限速：成功登录后计数清零（否则这里会 429）");

/* 12. 登出 */
ok((await post(boss, "/api/logout", {})).status === 200, "登出");
ok((await boss("/api/me")).data.user === null, "登出后会话失效");

server.close();

/* 13. 老库自迁移：已有 fin_entries 没有 to_ch 时首次请求自动补列 */
const db2 = new DatabaseSync(":memory:");
db2.exec(schema);
db2.exec(`CREATE TABLE fin_entries (
  id TEXT PRIMARY KEY, uid TEXT NOT NULL, by_name TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL, kind TEXT NOT NULL, cat TEXT NOT NULL DEFAULT '',
  ft TEXT NOT NULL DEFAULT 'life', ch TEXT NOT NULL DEFAULT 'cash',
  amount REAL NOT NULL DEFAULT 0, note TEXT NOT NULL DEFAULT '',
  photos TEXT NOT NULL DEFAULT '', to_uid TEXT NOT NULL DEFAULT '',
  created_by INTEGER, created_at TEXT NOT NULL, legacy_id TEXT)`);
const { default: worker2 } = await import(pathToFileURL(path.join(ROOT, "worker.js")).href + "?migrate=1");
const s2 = await startServer(worker2, { DB: new D1(db2), SETUP_TOKEN: "setup-xyz", FIN_OWNER: "boss@ecobox.com", PHOTOS });
const mig = client(s2.base);
await post(mig, "/api/setup", { login: "boss@ecobox.com", name: "老板", password: "ecobox2026" }, { "x-setup-token": "setup-xyz" });
await post(mig, "/api/login", { login: "boss@ecobox.com", password: "ecobox2026" });
await post(mig, "/api/users", { login: "p@ecobox.com", name: "P", password: "peter2026", role: "staff" });
const cols2 = db2.prepare("PRAGMA table_info(fin_entries)").all().map((c) => c.name);
ok(cols2.includes("to_ch"), "老库自动补上 to_ch 列：" + cols2.join(","));
const mt = await post(mig, "/api/fin/entries", { kind: "transfer", uid: "boss@ecobox.com", ch: "cash",
  to_uid: "p@ecobox.com", to_ch: "card", amount: 20, date: "2026-11-02" });
ok(mt.status === 201, "迁移后能写入转账");
const mtRow = mt.data && mt.data.id ? db2.prepare("SELECT to_ch FROM fin_entries WHERE id=?").get(mt.data.id) : null;
ok(mtRow && mtRow.to_ch === "card", "迁移后 to_ch 落库");

/* 14. 记一笔：金额 / 备注必填；有发票必须带照片 */
ok(cols2.includes("inv"), "老库自动补上 inv 列");
const OUT = { kind: "out", uid: "boss@ecobox.com", ch: "cash", date: "2026-11-02" };
ok((await post(mig, "/api/fin/entries", { ...OUT, amount: 30, note: "   " })).status === 400, "支出不填备注被拦下");
ok((await post(mig, "/api/fin/entries", { ...OUT, amount: 0, note: "打车" })).status === 400, "支出金额必须大于 0");
ok((await post(mig, "/api/fin/entries", { ...OUT, amount: 30, note: "打车", inv: 1, photos: [] })).status === 400, "选了有发票却没照片被拦下");
const invYes = await post(mig, "/api/fin/entries", { ...OUT, amount: 30, note: "打车", inv: 1, photos: ["k1.jpg"] });
ok(invYes.status === 201, "有发票 + 照片能记");
const invRow = invYes.data && invYes.data.id ? db2.prepare("SELECT * FROM fin_entries WHERE id=?").get(invYes.data.id) : null;
ok(invRow && invRow.inv === 1 && invRow.note === "打车", "inv=1 与备注落库");
const invNo = await post(mig, "/api/fin/entries", { ...OUT, amount: 12, note: "无票小费" });
const invNoRow = invNo.data && invNo.data.id ? db2.prepare("SELECT * FROM fin_entries WHERE id=?").get(invNo.data.id) : null;
ok(invNo.status === 201 && invNoRow && invNoRow.inv === 0, "没有发票时 inv=0");
ok((await patch(mig, "/api/fin/entries/" + invNo.data.id, { ...OUT, amount: 12, note: "无票小费", inv: 1 })).status === 400, "改成有发票但没照片被拦下");
ok((await patch(mig, "/api/fin/entries/" + invNo.data.id, { ...OUT, amount: 12, note: "" })).status === 400, "把备注清空被拦下");
ok((await mig("/api/fin/entries/" + invYes.data.id + "/photos", { method: "PUT", body: { photos: [] } })).status === 400, "有发票的记录不能把照片删掉");
ok((await mig("/api/fin/entries/" + invYes.data.id + "/photos", { method: "PUT", body: { photos: ["k1.jpg"] } })).status === 200, "有发票的记录可以换照片");

/* 15. 补票：老记录（无备注、无照片）人工标有票 / 无票 */
const putInv = (c, id, inv) => c("/api/fin/entries/" + id + "/inv", { method: "PUT", body: { inv } });
db2.prepare(`INSERT INTO fin_entries(id,uid,by_name,date,kind,cat,ft,ch,amount,note,photos,to_uid,to_ch,inv,created_by,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("old1", "boss@ecobox.com", "老板", "2026-10-01", "out", "meal", "life", "cash", 17, "", "[]", "", "", 0, null, "2026-10-01T00:00:00Z");
ok((await putInv(mig, "old1", 1)).status === 200, "老记录能标成有票（不需要备注照片）");
ok(db2.prepare("SELECT inv FROM fin_entries WHERE id=?").get("old1").inv === 1, "老记录 inv=1 落库");
ok((await putInv(mig, "old1", 0)).status === 200, "老记录能改回无票");
ok(db2.prepare("SELECT inv FROM fin_entries WHERE id=?").get("old1").inv === 0, "老记录 inv=0 落库");
ok((await putInv(mig, "nope", 1)).status === 404, "不存在的记录 404");
ok((await putInv(mig, mt.data.id, 1)).status === 400, "转账不能标发票");
const emp = client(s2.base);
await post(emp, "/api/login", { login: "p@ecobox.com", password: "peter2026" });
ok((await putInv(emp, "old1", 1)).status === 403, "员工不能标别人的记录");

/* 16. 分类合并：老键写入即纠正 + 老键合并到新分类 */
const oldCat = await post(mig, "/api/fin/entries", { ...OUT, amount: 9, note: "快递费", cat: "postage" });
ok(oldCat.status === 201, "老分类 postage 仍能写入");
ok(db2.prepare("SELECT cat FROM fin_entries WHERE id=?").get(oldCat.data.id).cat === "misc", "写入时 postage 自动转 misc");
const insOld = (id, cat) => db2.prepare(`INSERT INTO fin_entries(id,uid,by_name,date,kind,cat,ft,ch,amount,note,photos,to_uid,to_ch,inv,created_by,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(id, "boss@ecobox.com", "老板", "2026-09-01", "out", cat, "life", "cash", 5, "老分类", "[]", "", "", 0, null, "2026-09-01T00:00:00Z");
insOld("old2", "daily");
insOld("old3", "other");
insOld("old4", "lodging");
insOld("old5", "repair");
insOld("old6", "home");
const dryRun = await mig("/api/fin/cats/merge?dry=1", { method: "POST" });
ok(dryRun.status === 200 && dryRun.data.total === 3, "dry-run 报出 3 条待合并", JSON.stringify(dryRun.data));
ok(dryRun.data.ftFixed === 1, "dry-run 报出 1 条往来归属修正", JSON.stringify(dryRun.data));
ok(db2.prepare("SELECT cat FROM fin_entries WHERE id='old2'").get().cat === "daily", "dry-run 不动数据");
const merged = await mig("/api/fin/cats/merge", { method: "POST" });
ok(merged.status === 200 && merged.data.total === 3, "合并成功 3 条");
ok(merged.data.ftFixed === 1, "归属修正 1 条");
ok(db2.prepare("SELECT cat,ft FROM fin_entries WHERE id='old6'").get().ft === "ledger", "家庭开支的 ft 修正为 ledger");
ok(db2.prepare("SELECT cat FROM fin_entries WHERE id='old2'").get().cat === "misc", "daily → misc");
ok(db2.prepare("SELECT cat FROM fin_entries WHERE id='old3'").get().cat === "misc", "other → misc");
ok(db2.prepare("SELECT cat FROM fin_entries WHERE id='old4'").get().cat === "meal", "lodging → meal（餐饮住宿）");
ok(db2.prepare("SELECT cat FROM fin_entries WHERE id='old5'").get().cat === "repair", "维修是正式分类，不再被合并成其它");
const licPut = await mig("/api/fin/cats", { method: "PUT", body: { life: [], project: ["serenje"], licence: ["1330NW", "1331SE"], names: {} } });
ok(licPut.status === 200, "分类配置能带矿权维护");
const cfgCats = (await mig("/api/fin/bootstrap")).data.cats;
ok(cfgCats.licence.join(",") === "1330NW,1331SE", "矿证列表落库", JSON.stringify(cfgCats));
/* 20. 生产：产品 / 数量 / 单位 / 品位 / 照片 */
const prodPost = await post(mig, "/api/logs", {
  day: "2026-11-01", site: "Serenje 1330NW", product: "钽铌精矿",
  qty: 5, unit: "kg", ta: 9.5, nb: 8, note: "一台摇床", photos: ["prod/2026-11/a.jpg", "prod/2026-11/b.jpg"],
});
ok(prodPost.status === 201, "生产记录能写产量字段");
const prodRow = db2.prepare("SELECT * FROM logs WHERE id=?").get(prodPost.data.id);
ok(prodRow.product === "钽铌精矿" && prodRow.qty === 5 && prodRow.unit === "kg", "产品 / 数量 / 单位落库");
ok(Math.abs(prodRow.ore_t - 0.005) < 1e-9, "公斤折算成吨写进 ore_t（吨口径不变）");
ok(JSON.parse(prodRow.photos).length === 2, "照片 key 存成 JSON 数组");
const tonPost = await post(mig, "/api/logs", { day: "2026-11-01", site: "Serenje 1330NW", qty: 3, unit: "t" });
ok(db2.prepare("SELECT ore_t FROM logs WHERE id=?").get(tonPost.data.id).ore_t === 3, "按吨填就直接进 ore_t");
const bagPost = await post(mig, "/api/logs", { day: "2026-11-02", site: "Serenje 1330NW", qty: 12, unit: "bag" });
ok(db2.prepare("SELECT ore_t FROM logs WHERE id=?").get(bagPost.data.id).ore_t === 0, "按袋填不折算吨");
const manyShot = await post(mig, "/api/logs", { day: "2026-11-02", site: "Serenje 1330NW", qty: 1, photos: Array.from({ length: 9 }, (_, i) => "p" + i + ".jpg") });
ok(JSON.parse(db2.prepare("SELECT photos FROM logs WHERE id=?").get(manyShot.data.id).photos).length === 6, "照片最多存 6 张");
const badUnit = await post(mig, "/api/logs", { day: "2026-11-03", site: "Serenje 1330NW", qty: 2, unit: "箱" });
ok(db2.prepare("SELECT unit FROM logs WHERE id=?").get(badUnit.data.id).unit === "kg", "不认识单位回落到 kg");
ok((await patch(mig, "/api/logs/" + prodPost.data.id, { note: "改了备注" })).status === 200, "能改生产记录");
const patchedProd = db2.prepare("SELECT * FROM logs WHERE id=?").get(prodPost.data.id);
ok(patchedProd.qty === 5 && JSON.parse(patchedProd.photos).length === 2 && patchedProd.ore_t === 0.005, "改备注不动数量 / 照片 / 折算");
const listProd = (await mig("/api/logs?from=2026-11-01&to=2026-11-01")).data.logs.find((x) => x.id === prodPost.data.id);
ok(listProd && listProd.product === "钽铌精矿" && JSON.parse(listProd.photos).length === 2, "列表接口带出产量和照片");
const empProd = client(s2.base);
await post(empProd, "/api/login", { login: "p@ecobox.com", password: "peter2026" });
ok((await patch(empProd, "/api/logs/" + prodPost.data.id, { note: "员工改别人的" })).status === 403, "员工不能改别人的生产记录");

/* 21. 公司资料库：建档 / 股东折算 / 权限 / 批量导入 / 删除 */
const coCreate = await post(mig, "/api/companies", {
  name: "Test Mining Ltd", reg_no: "120200012345", reg_date: "2019-04-01",
  address: "Lusaka", share_capital: 100000, phone: "+260 97 0000000",
  shareholders: [
    { name: "Zhang San", nationality: "China", id_no: "E123", amount: 90000 },
    { name: "Local Partner", nationality: "Zambia", id_no: "123456/11/1", amount: 10000 },
  ],
  directors: [{ name: "Zhang San", nationality: "China", id_no: "E123", role: "Director" }],
});
ok(coCreate.status === 201, "能建公司档案", JSON.stringify(coCreate.data));
const coId = coCreate.data.company.id;
ok(coCreate.data.company.id.startsWith("co"), "公司 id 由服务端生成");
ok(coCreate.data.company.zm_pct === 10, "赞方持股按注册资本折算成 10%", String(coCreate.data.company.zm_pct));
ok(coCreate.data.company.shareholders[0].pct === 90, "中方 90%");
const coList = await mig("/api/companies?q=Test%20Mining");
ok(coList.status === 200 && coList.data.companies.length === 1, "按名字搜到公司");
ok((await mig("/api/companies?q=1202000")).data.companies.length === 1, "按 PACRA 号也能搜到");
const coNoName = await post(mig, "/api/companies", { reg_no: "x" });
ok(coNoName.status === 400, "公司名必填");
const coPatch = await patch(mig, "/api/companies/" + coId, { phone: "+260 96 1111111", share_capital: 200000 });
ok(coPatch.status === 200 && coPatch.data.company.phone === "+260 96 1111111", "能改公司信息");
ok(coPatch.data.company.shareholders[1].pct === 5, "改注册资本后比例重算（5%）");
const coStaff = client(s2.base);
await post(coStaff, "/api/login", { login: "p@ecobox.com", password: "peter2026" });
ok((await post(coStaff, "/api/companies", { name: "Staff Co" })).status === 403, "员工不能建公司");
ok((await patch(coStaff, "/api/companies/" + coId, { name: "Hacked" })).status === 403, "员工不能改公司");
ok((await coStaff("/api/companies/" + coId, { method: "DELETE" })).status === 403, "员工不能删公司");
const coBulk = await post(mig, "/api/companies/bulk", { companies: [
  { name: "Bulk One Ltd", reg_no: "B1" },
  { name: "Bulk Two Ltd", reg_no: "B2", shareholders: [{ name: "A", nationality: "Zambia", amount: 5 }] },
] });
ok(coBulk.status === 201 && coBulk.data.added === 2, "批量导入 2 家", JSON.stringify(coBulk.data));
ok((await mig("/api/companies/bulk", { method: "POST", body: { companies: [] } })).status === 400, "空列表拒绝导入");
ok((await mig("/api/companies/" + coId, { method: "DELETE" })).status === 200, "管理员能删公司");
ok((await mig("/api/companies/" + coId)).status === 404, "删掉后查不到");

/* 21b. 公司资料（PDF）：上传 / 下载 / 校验 / 删除 */
const coDoc = await post(mig, "/api/companies", { name: "Doc Co Ltd" });
const docId = coDoc.data.company.id;
const pdf = "data:application/pdf;base64," + Buffer.from("%PDF-1.4 hello").toString("base64");
const docUp = await post(mig, "/api/companies/" + docId + "/doc", { data: pdf, name: "证书.pdf", label: "公司注册证" });
ok(docUp.status === 201 && docUp.data.docs.length === 1, "能上传 PDF 资料 " + JSON.stringify(docUp.data).slice(0, 200));
ok(docUp.data.doc && docUp.data.doc.mime === "application/pdf" && docUp.data.doc.size === 14, "资料记了 mime 和字节数");
ok(docUp.data.doc.key.startsWith("company/" + docId + "/"), "文件落在 company/<id>/ 下");
ok(R2.has(docUp.data.doc.key), "文件真的进了对象存储");
const docK = docUp.data.doc.k;
const docGet = await mig("/api/companies/" + docId + "/doc/" + docK);
ok(docGet.status === 200 && docGet.headers.get("content-type") === "application/pdf", "能下载资料");
ok(/attachment|inline/.test(docGet.headers.get("content-disposition") || ""), "下载带 disposition");
const badMime = await post(mig, "/api/companies/" + docId + "/doc", { data: "data:image/gif;base64,R0lGODlh", name: "a.gif" });
ok(badMime.status === 400, "不收 gif");
const badData = await post(mig, "/api/companies/" + docId + "/doc", { data: "not-a-data-url", name: "x.pdf" });
ok(badData.status === 400, "非 data URL 被拒");
ok((await post(coStaff, "/api/companies/" + docId + "/doc", { data: pdf, name: "x.pdf" })).status === 403, "员工不能传资料");
const docDel = await mig("/api/companies/" + docId + "/doc?k=" + docK, { method: "DELETE" });
ok(docDel.status === 200 && docDel.data.docs.length === 0, "能删资料");
ok(!R2.has(docUp.data.doc.key), "删资料时对象存储也清了");
ok((await mig("/api/companies/" + docId + "/doc/" + docK)).status === 404, "删完下载 404");
const docBulk = await post(mig, "/api/companies", { name: "Doc Bulk Ltd", docs: [{ k: "d1", name: "a.pdf", key: "company/x/d1.pdf", mime: "application/pdf", size: 10 }] });
ok(docBulk.status === 201 && docBulk.data.company.docs.length === 1, "建公司时可带资料元数据");
ok((await post(mig, "/api/companies", { name: "Doc Bad Ltd", docs: [{ k: "d1", name: "a.pdf" }] })).data.company.docs.length === 0, "没有 key 的资料条目被丢弃");

const empMerge = client(s2.base);
await post(empMerge, "/api/login", { login: "p@ecobox.com", password: "peter2026" });
ok((await empMerge("/api/fin/cats/merge", { method: "POST" })).status === 403, "员工不能合并分类");
s2.close();

/* 页面脚本自检：can*、is*、td*、draw*、paint* 开头的辅助函数必须有定义
   （曾漏改 canAssign -> canManage，点「新建待办」抛 ReferenceError，界面毫无反应） */
{
  const page = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const script = page.slice(page.lastIndexOf("<script>") + 8, page.lastIndexOf("</script>"));
  const called = new Set([...script.matchAll(/(?<![.\w$])((?:can|is|td|draw|paint)[A-Z]\w*)\s*\(/g)].map((m) => m[1]));
  const defined = new Set([...script.matchAll(/(?:const|let|var|function)\s+([\w$]+)/g)].map((m) => m[1]));
  const builtin = new Set(["isNaN", "isFinite", "isArray", "isPrototypeOf", "isInteger", "isSafeInteger"]);
  const missing = [...called].filter((n) => !defined.has(n) && !builtin.has(n));
  ok(missing.length === 0, "页面脚本没有未定义的辅助函数" + (missing.length ? "：" + missing.join(",") : ""));
}

/* 页面脚本语法 + 英文覆盖：改模板/加文案最容易在这里翻车 */
{
  const page = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const script = page.slice(page.lastIndexOf("<script>") + 8, page.lastIndexOf("</script>"));
  let err = null;
  try { new Function(script); } catch (e) { err = e.message; }
  ok(!err, "页面脚本语法通过" + (err ? "：" + err : ""));
  const r = spawnSync(process.execPath, [path.join(ROOT, "test", "i18n.mjs"), "--json"], { encoding: "utf8" });
  const miss = r.status === 0 ? [] : JSON.parse(r.stdout || "[]");
  ok(miss.length === 0, "英文模式没有漏翻的 tr() 文案" + (miss.length ? "：" + miss.slice(0, 5).join(" ｜ ") : ""));
}

/* 水单解析：用页面里同一段代码跑两份样例（FCB 倒序 / IZB 正序），防止改模板改坏 */
{
  const page = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const a = page.indexOf("const BANK_MON =");
  const b = page.indexOf("/* 常用花费人");
  const mod = new Function(page.slice(a, b) + "\nreturn { bankParseText, bankSuggestCat };")();
  const fcb = [
    "Statement Period:   01-11-2026 To 02-11-2026",
    "Opening balance:   1,000.00",
    "Closing balance:   800.00",
    "Credits:   0.00",
    "Debits:   200.00",
    "03-11-2026   03-11-2026   SAFEEINCOME with Ref No.",
    "S3   10.00   800.00",
    "02-11-2026   02-11-2026   PUMA fuel",
    "S2   190.00   810.00",
  ].join("\n");
  const r1 = mod.bankParseText(fcb);
  ok(r1.calc.n === 2, "水单（倒序版）解析出 2 笔，得到 " + r1.calc.n);
  ok(Math.abs(r1.calc.debit - 200) < 0.01 && Math.abs(r1.calc.credit) < 0.01, "倒序水单借贷方向正确 " + JSON.stringify(r1.calc));
  ok(r1.meta.pf === "2026-11-01" && r1.meta.pt === "2026-11-02", "期间能认出来 " + r1.meta.pf + "~" + r1.meta.pt);
  ok(Math.abs(Number(r1.meta.open_bal) - 1000) < 0.01 && Math.abs(Number(r1.meta.close_bal) - 800) < 0.01, "期初期末认出");
  ok(r1.warn === "", "借贷合计与表头一致，不报警 " + r1.warn);
  const izb = [
    "E-banking Account Statement",
    "Account Number :   0391020000704   From Date :   01-OCT-2026   To Date :   02-OCT-2026",
    "Opening Balance :   0.00",
    "Trn Date   Value Date   Transaction Details   Instrument   Debit   Credit   Balance",
    "01-OCT-2026   01-OCT-2026   NFS DEPOSIT",
    "1,000.00   1,000.00",
    "02-OCT-2026   02-OCT-2026   FUEL PUMA",
    "300.00   700.00",
    "Total :    300.00    1,000.00",
  ].join("\n");
  const r2 = mod.bankParseText(izb);
  ok(r2.calc.n === 2, "水单（正序版）解析出 2 笔，得到 " + r2.calc.n);
  ok(Math.abs(r2.calc.credit - 1000) < 0.01 && Math.abs(r2.calc.debit - 300) < 0.01, "正序水单借贷方向正确 " + JSON.stringify(r2.calc));
  ok(r2.meta.pf === "2026-10-01" && r2.meta.pt === "2026-10-02", "NOV/OCT 这种月份写法能转成日期");
  ok(r2.warn === "" && r2.meta.acct_no === "0391020000704", "账号与合计都对得上 " + r2.meta.acct_no);
  ok(mod.bankSuggestCat("PUMA fuel woodlands") === "fuel", "摘要猜科目：加油");
  ok(mod.bankSuggestCat("SAFEEINCOME with Ref No. 123") === "bankfee", "摘要猜科目：手续费");
  ok(mod.bankSuggestCat("xyz nothing") === "", "认不出来的摘要不乱给科目");

  /* IZB 真水单里余额会换行、摘要跨 3 行；解析丢了尾巴也不能装作没事 */
  const izbWrapHead = [
    "E-banking Account Statement",
    "Account Number :   0391020000704   From Date :   01-OCT-2026   To Date :   02-OCT-2026",
    "Opening Balance :   0.00",
    "Closing Balance :   91,400.00",
    "01-OCT-2026   01-OCT-2026   NFS DEPOSIT/TRANSFER",
  ];
  const izbWrap = izbWrapHead.concat([
    "100,000.00   100,000.00",
    "02-OCT-2026   02-OCT-2026   POS PURCHASE (PAC)- TOTAL ZAMBIA-",
    "3,600.00",
    "96,400.00",
    "02-OCT-2026   02-OCT-2026   ATM CASH WITHDRAWAL Serenje ZM",
    "Term ID :030-ATM1 008377",
    "5,000.00   91,400.00",
    "Total :    8,600.00    100,000.00",
  ]).join("\n");
  const r3 = mod.bankParseText(izbWrap);
  ok(r3.calc.n === 3, "余额换行、摘要跨行的水单解析出 3 笔，得到 " + r3.calc.n);
  ok(Math.abs(r3.calc.debit - 8600) < 0.01 && Math.abs(r3.calc.credit - 100000) < 0.01, "换行水单借贷方向正确 " + JSON.stringify(r3.calc));
  ok(r3.warn === "", "换行水单合计对得上不报警 " + r3.warn);

  const truncated = izbWrapHead.concat(["100,000.00   100,000.00", "Total :    8,600.00    100,000.00"]).join("\n");
  const r4 = mod.bankParseText(truncated);
  ok(r4.calc.n === 1, "少了尾巴的水单只解析出 1 笔，得到 " + r4.calc.n);
  ok(r4.warn === "借方合计对不上", "少了尾巴要报警，得到 " + (r4.warn || "（没报）"));
}

console.log((fail ? "FAILED " : "OK ") + "PASS=" + pass + " FAIL=" + fail);
process.exit(fail ? 1 : 0);
