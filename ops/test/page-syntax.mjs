/* 页面内联脚本语法检查（build 前跑，防止模板里改坏引号） */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const script = html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));
fs.writeFileSync(path.join(ROOT, ".page-check.js"), script, "utf8");
try {
  new Function(script);
  console.log("page script: syntax OK (" + script.length + " chars)");
} catch (e) {
  console.log("page script: SYNTAX ERROR — " + e.message);
  process.exit(1);
} finally {
  fs.rmSync(path.join(ROOT, ".page-check.js"), { force: true });
}
