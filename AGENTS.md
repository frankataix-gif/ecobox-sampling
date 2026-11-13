# AGENTS.md · ecobox-sampling

> 给后续 agent 的最小须知：只放「怎么不犯错」和「什么不许动」。实现细节读源码，不在这里复述。

## 0. 干活方式（省时间、少出错）

1. 一次一条命令，别把 build+test+deploy 串成一长串；长命令（python 部署/构建）结束后壳子可能挂住，看到 "still running" 直接 `reset=true` 重开，不要干等。
2. PowerShell 5.1 内联中文/JSON 必乱码 → **写 `.py` 文件再跑**，脚本首部 `sys.stdout.reconfigure(encoding="utf-8")`。
3. 改文件用 file_editor；不要用 `Get-Content`/`Set-Content` 循环改 UTF-8 文件（按 GBK 读，中文不可逆损坏）。
4. 先读真实文件再断言；不确定就问，不猜。
5. 改完的标准动作：`python ops/build.py` → `node ops/test/local.mjs`（必须 `FAIL=0`，内含页面语法 + 英文覆盖率两道闸）→ `node --check ops/dist/worker.js` → `python ops/deploy.py --code-only`（token 无 D1 权限时用它，从 Worker 绑定读 D1 id）→ 核对 `https://ops.ecoboxmine.com/api/build` 时间戳。

## 1. 这个仓库是什么

单文件离线 PWA 采集工具 + 静态站 + `ops/` 运营工作台（Cloudflare Worker `ecobox-ops` = 页面 + API + D1 + R2）。

- 生产：`https://ops.ecoboxmine.com`（备用 `https://ecobox-ops.frankataix.workers.dev`）
- account `dff446b2b98a38ac2b82263e3ff14da9`；D1 `9c9f6539-a564-461c-8ba8-e04a2f7eb198`；R2 `ecobox-finance`（binding `PHOTOS`）
- 源码 `ops/index.html` + `ops/worker.js` → `python ops/build.py` → `ops/dist/worker.js`（页面内联进 worker）
- 测试 `node ops/test/local.mjs`：本地内存 D1，不碰生产

## 2. 部署

- 命令文本里必须出现 `CLOUDFLARE_OPS_TOKEN` / `CLOUDFLARE_API_TOKEN` 键名，系统才注入 token；**终端 reset 会清空环境变量**，重跑时键名要重新出现在命令里。
- 部署成功与否只看 `/api/build` 时间戳，别看退出码（`deploy.py` 走 `os._exit`，壳子无输出甚至挂住是正常的）。
- `/d1/database` 报 401 不是 token 失效（`/user/tokens/verify` 仍是 active），是缺 D1 读权限 → 用 `python ops/deploy.py --code-only` 只换代码。
- `*.workers.dev` 会被部分网络/运营商拦 → 手机打不开先换自定义域，别先怀疑 worker。

## 3. ops 结构（够用就行）

- 前端单页：全局 `S`、`render()`、模块表 `MODS` / 分组 `GROUPS`，每个模块一个 `xxxPane()`；**模块 = 独立页**（`enterApp()` / `ROOT()` / `syncChrome()`），别改回页签。
- 后端：`ops/worker.js` 单个 `fetch` 按前缀分派 `/api/{login,me,users,modules,posts,logs,fin,todos,att,customers,exports,licence,...}`；建表靠首次请求自迁移（`CREATE TABLE IF NOT EXISTS` + ALTER）。
- 双语：界面走 `EN` 字典 + `tr()`（新增中文串补进 `EN`）；内容走 `*_zh / *_en` 双列 + `tx()`。
  `tr()` 命中不了的动态串写进 `EN_RULES`（数字/变量用函数式替换）。原生 `confirm()/alert()` 不在 DOM 里，**必须** `tr()`；
  其余渲染文字由 `applyLang()` + MutationObserver 兜底翻（含 `.textContent` 写入的文本节点）。
  兜底只认「整串中文精确命中字典/规则」，所以**不写 `tr()` 的静态中文也必须进 `EN`**：`node ops/test/i18n.mjs` 现在两道闸
  （`tr()` 字面量 + 未包 `tr()` 但会进 DOM 的中文），缺一条就 `FAIL`。带 `${}` 的拼接串（如「现金 X · 银行 Y」）只能靠 `EN_RULES` 正则兜。
- 角色：`staff` / `manager` / `finance` / `admin`。

### 银行水单（独立模块「银行账单」，财务组）

- 独立页（`bankPane()` / `bankPageHtml()` / `bindBank()`），路由 `#bank`；财务页底部只留一个「打开」入口（`data-go="bank"`）。模块目录在 `worker.js` 的 `MODULES` 里注册（`k: "bank"`）。
- 解析全在浏览器：`bankParseText()` 认期初/期末/账号/币种/期间，按「上一行余额 − 本行余额」定借贷；首行日期 > 末行日期时自动 reverse 成从旧到新。逐笔只在弹窗里改，点保存才写 D1。
- 定位：**按日期把账单一笔笔列出来，人眼逐笔核对**（不做自动配对，不求跟费用记录对齐）。
- 详情弹窗 `finBankOpen()`：按 `d` 升序（同一天保持录入顺序）列出「日期 / 摘要 / 进或出 / 余额」，逐行「☐ 待核 → ✓ 已核」+「不管这行」，改动先攒在内存，点「保存核对」一次性 `POST /fin/bank/:id/tx`；全部核完自动把水单 `status=checked`。
- 期初 + 进 − 出 = 期末 由页面现算（`bk-chk` 条），和水单期末对不上就标红提示，用来发现解析错行/漏行。
- `fin_bank_stmt` 的列表查询统一走 `FIN_BANK_SEL`（带 `ok_n` 和 `gap`），`/fin` 树和 `/fin/bank` 列表都用它；`gap` = 期初 + 逐笔进 − 逐笔出 − 表头期末，列表行据此打「⚠ 缺行」。加字段时**两边一起改**，别只在 `/fin/bank` 里算——页面用的是 `/fin` 树里的 `FIN.bank`。
- 列表行右侧「0/6」= 已核笔数 / 总笔数（`ok_n` 由 SQL 子查询算，别在前端遍历）；KPI 用「已核笔数」代替原来的「有差异」。
- 后端两张表：`fin_bank_stmt`（一张水单）+ `fin_bank_tx`（逐笔，`state` = `new` / `matched` / `ignored` 正好对应 待核 / 已核 / 不管），原件进 R2 的 `bank/` 前缀；端点 `/fin/bank*`。可见性：`bank`＝自己名下，`bankAll`＝财务负责人 / admin / manager。
- 上传默认记到「自己」名下；只有 `bankAll` 能选公司账户或替别人传。普通员工可以传自己名下的水单，但没有 `bankAll` 时弹窗只读（不能改状态）。
- 同 uid + 同期间重传 → 旧记录标 `old=1` 留着（列表显示「旧版本」），不做覆盖。
- 改完跑 `node ops/test/local.mjs`：里面用页面里同一段解析代码跑两份样例（FCB 倒序 / IZB 正序）做回归，另有上传/核对/分权/删除的接口用例。另有两例覆盖真水单的坑：IZB 的余额会换行（金额在上一行末尾、余额单独一行）、摘要跨 3 行；少了尾巴时 `warn` 必须报「借方合计对不上」。
- 想离线复现真 PDF 的解析：`pdfjs-dist` 的 legacy build 在 node 里能跑（`import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"`），把 `bankPdfText()` 那段逻辑抄过去即可；`pdftotext -layout`（Poppler）也能抽文本，但行切分跟 pdf.js 不完全一样，只能当参照。
- `deploy.py` 结尾 `os._exit(0)` 会丢掉重定向里的缓冲输出 → 看不到日志时用 `python -u ops\deploy.py --code-only`。

## 4. 不变式（不许动）

- **`login` 是关联键**（`fin_entries.uid`、`todos.owner`、`todo_notes.uid`…）。改名走 `renameLogin()`，**不要直接改 D1 的 login**。
- 人员**软删**：`deleted=1`、清会话、login 改 `<原>#del<id>`；不能删自己、不能删最后一个管理员。
- **待办完成权**：只有创建人能确认完成；执行人只能「提交完成」→ 创建人审核通过才 `done`；自排任务（creator=owner）提交即完成；公司事项管理层提交即完成；非创建人 `PATCH status=done` 一律 403。
- 待办删除只给 `creator` / `admin`；汇报只认 `owner`（admin/manager 也不能代报）。
- 打卡迟到/早退只认本人本地的 `in_hm / out_hm`（服务端 UTC 不算钟点）。
- 附件/照片只收白名单 MIME、≤25MB；HTML/SVG 一律 `attachment` 回，不在本域执行。

## 5. 环境约束

- QGIS 4.2.2 用 `"C:\Program Files\QGIS 4.2.2\bin\python-qgis.bat" script.py`；系统 python 无 gdal/shapely，**别 pip 装**。
- 改了缓存内容必须 bump `sampling_sw.js` 的 `CACHE`（`sampling-vNN`），否则老客户端不更新。
- QGIS 不监视磁盘上的 `.qgz`：外部改完要「关 QGIS → 不保存 → 重开」。

## 6. 未完成 / 待办（动手前先问）

- 矿证模块搬迁：`ops/licence.html` + `/_lic/*`（D1 状态 + R2 媒体）未接完。
- 首页「矿证」快捷入口仍指向外部 mine-sync。
- 公司模块：搜索收纳 + 新建时选资料。
