/* 英文模式覆盖率检查：页面里每个 tr("...") 的字面量都要能在 EN 字典或 EN_RULES 里命中。
 * 用法：node ops/test/i18n.mjs        只报告
 *       node ops/test/i18n.mjs --json 输出机器可读清单
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));

function block(startMarker) {
  const i = script.indexOf(startMarker);
  if (i < 0) throw new Error("not found: " + startMarker);
  const open = script.indexOf("{", i) >= 0 && script.indexOf("{", i) < script.indexOf("[", i) ? "{" : "[";
  const from = script.indexOf(open, i);
  const close = open === "{" ? "}" : "]";
  let depth = 0, inStr = null, esc = false;
  for (let k = from; k < script.length; k++) {
    const ch = script[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (!depth) return script.slice(from, k + 1); }
  }
  throw new Error("unbalanced: " + startMarker);
}

const EN = new Function("return " + block("const EN = {"))();
const EN_RULES = new Function("return " + block("const EN_RULES = ["))();

const keys = new Set();
const synth = (raw) =>
  raw
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\$\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "1")
    .trim();
for (const m of script.matchAll(/\btr\(\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1\s*(?:,[^)]*)?\)/g)) {
  const v = synth(m[2]);
  if (v && /[\u4e00-\u9fff]/.test(v)) keys.add(v);
}
/* 传进 tr() 的三元/拼接里的字面量 */
for (const m of script.matchAll(/\btr\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
  for (const s of m[1].matchAll(/(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g)) {
    const v = synth(s[2]);
    if (/[\u4e00-\u9fff]/.test(v)) keys.add(v);
  }
}

const hit = (k) => EN[k] !== undefined || EN_RULES.some(([re]) => re.test(k));

/* 第二道：没走 tr()、但会以文本节点/属性出现在 DOM 里的中文（applyLang 兜底靠字典命中）。
 * 跳过：HTML 片段、字符串拼接片段、纯数据键（渲染时另行 tr）。 */
const RAW_SKIP = new Set(["u:员工工资", "g:系统"]);
const rawKeys = new Set();
const lit = /(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/g;
for (const line of script.split("\n")) {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*")) continue;
  if (/"\s*\+|\+\s*"/.test(line)) continue;
  for (const m of line.matchAll(lit)) {
    const raw = m[2];
    if (!/[\u4e00-\u9fff]/.test(raw) || raw.includes("<")) continue;
    const before = line.slice(0, m.index).trimEnd();
    if (before.endsWith("tr(") || before.endsWith("tr(`")) continue;
    const v = synth(raw);
    if (!v || !/[\u4e00-\u9fff]/.test(v) || RAW_SKIP.has(v)) continue;
    rawKeys.add(v);
  }
}

const missing = [...keys].filter((k) => !hit(k)).sort((a, b) => b.length - a.length);
const rawMissing = [...rawKeys].filter((k) => !hit(k)).sort((a, b) => b.length - a.length);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify([...new Set([...missing, ...rawMissing])], null, 1));
} else {
  console.log(`tr() 字面量 ${keys.size} 条，缺英文 ${missing.length} 条`);
  for (const k of missing) console.log(" - tr：" + k);
  console.log(`未包 tr() 的中文 ${rawKeys.size} 条，缺英文 ${rawMissing.length} 条`);
  for (const k of rawMissing) console.log(" - 兜底：" + k);
}
process.exit(missing.length || rawMissing.length ? 1 : 0);
