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
- **页面渲染冒烟** `node ops/test/render.mjs [boss|mgr|fin|staff]`：用 jsdom 打开真页面，把 18 个页签和记账/调拨/取现弹层点一遍，任何渲染异常（比如 TDZ「before initialization」）都会报红。需要先 `npm i jsdom`（不进依赖，没装就 SKIP）。tabs / 弹层抛错会被 `showPaneError` 拦成「这个页面打不开 + 重试」，不再卡在「加载中…」。
- 测试 `node ops/test/local.mjs`：本地内存 D1，不碰生产

## 2. 部署

- 命令文本里必须出现 `CLOUDFLARE_OPS_TOKEN` / `CLOUDFLARE_API_TOKEN` 键名，系统才注入 token；**终端 reset 会清空环境变量**，重跑时键名要重新出现在命令里。
- 部署成功与否只看 `/api/build` 时间戳，别看退出码（`deploy.py` 走 `os._exit`，壳子无输出甚至挂住是正常的）。
- `/d1/database` 报 401 不是 token 失效（`/user/tokens/verify` 仍是 active），是缺 D1 读权限 → 用 `python ops/deploy.py --code-only` 只换代码。
- `*.workers.dev` 会被部分网络/运营商拦 → 手机打不开先换自定义域，别先怀疑 worker。

## 3. ops 结构（够用就行）

- 前端单页：全局 `S`、`render()`、模块表 `MODS` / 分组 `GROUPS`，每个模块一个 `xxxPane()`；**模块 = 独立页**（`enterApp()` / `ROOT()` / `syncChrome()`），别改回页签。
- **顶部页签只有三个**：目录（`home`，默认页）/ 动态（`status`）/ 系统（`g:系统`），在 `buildTabs()` 里写死；财务、日常协同、业务现场、资产这些分组**不进顶部**，靠目录页的卡片进（分组页仍可用 `#g:财务` 深链，`groupHtml()` 保留）。**顶部高亮要跟内容一致**：进了 `g:系统` 就亮「系统」，由 `tabCur()` 判断——本页自己就是顶部页签才亮自己，`g:财务` 这类不在顶部的组页仍算「目录」。
- 后端：`ops/worker.js` 单个 `fetch` 按前缀分派 `/api/{login,me,users,modules,posts,logs,fin,todos,att,customers,exports,licence,...}`；建表靠首次请求自迁移（`CREATE TABLE IF NOT EXISTS` + ALTER）。
- 写请求的即时反馈：`api()` 里凡是 `method !== "GET"` 都会 `busyOn()`——把用户刚点的按钮改成「处理中…」+ 禁用（`LIVEBTN` 由 document 捕获阶段点击记录），底部浮条 `showUpd(…, "wait")` 转圈且不自动消失；请求结束（含失败）`busyOff()` 还原。新增确认按钮不用自己写 loading，只要走 `api()`。
- 双语：界面走 `EN` 字典 + `tr()`（新增中文串补进 `EN`）；内容走 `*_zh / *_en` 双列 + `tx()`。
  `tr()` 命中不了的动态串写进 `EN_RULES`（数字/变量用函数式替换）。原生 `confirm()/alert()` 不在 DOM 里，**必须** `tr()`；
  其余渲染文字由 `applyLang()` + MutationObserver 兜底翻（含 `.textContent` 写入的文本节点）。
  兜底只认「整串中文精确命中字典/规则」，所以**不写 `tr()` 的静态中文也必须进 `EN`**：`node ops/test/i18n.mjs` 现在两道闸
  （`tr()` 字面量 + 未包 `tr()` 但会进 DOM 的中文），缺一条就 `FAIL`。带 `${}` 的拼接串（如「现金 X · 银行 Y」）只能靠 `EN_RULES` 正则兜。
- 角色：`staff` / `manager` / `finance` / `admin`。

### 财务账目设置（独立模块「系统 › 财务账目设置」，`k: "finacct"`）

- 基础设置只在这个页：`finAcctHtml()` + `bindFinAcct()`，路由 `#finacct`；页面渲染期初/对账基准/建删改/初始化，服务端仍只认财务负责人（`isOwner`）。
- **费用记录页（`fin`）不再放基础设置**，只留记账 + 统计；期初表单（`fo_*`）、分类（`fin_cats` / `fin_merge`）也已搬到这个页，改之前先看 `bindFinAcct()`。
- 账户行存在 `fin_accounts(uid,…)`：`__company` 是公司账户；删账户 = 删这一行，`fin_entries` 一条不动（余额回落成流水合计）。
- **银行卡只有这一个登记处（唯一口径）**：`fin_accounts.banks` 每条 `{ id, name, holder, bank, no, ccy, bal }`，`id` 由服务端发（`newBankId()` = `c` + 15 位），老数据由 `finSchema()` 里的 `finBankCardFix()` 补 id，并按「同主体 + 同账号」回填账单 / 原件的 `card_id`。**卡号全局唯一**：写账户时 `finBankClash()` 校验，撞了返回 409（一张卡只属于一个主体）。账单 / 原件 / 报表都只引用这张卡，不再各填一套银行 + 账号。
- 银行余额只认卡：`bal` = 该卡期初；`finBanksClean()` 只收有限数字（两位小数），空/脏值不写，读出来是「未分配」，绝不会被当成 0。账户的 `card` = Σbal（页面显示「各卡合计」只读）。期初口径只有两处：每人的 `cash` + 每张卡的 `bal`；**「报表期初」（`fin_cfg.opening` / `PUT /fin/opening`）已下线**，报表直接用账户期初，别再把它加回来。
- **现金跟卡解耦**：`cash` 是每人一个手工数字（「现金期初（人工）」），不绑卡、不参与卡号唯一性校验。
- 单卡增改删走 `finBankCardSheet(uid, idx)`（行尾「设置」）；改卡必须回传原 `id`，否则账单 / 原件的 `card_id` 会变孤儿。
- `name`（卡名 / 用途，≤30 字）和 `holder`（户名，≤60 字）都是**可选**：同一家银行多个户时靠 `name` 区分（经营户 / 工资户 / USD 结算），显示的优先级是「卡名 · 银行 · …尾号」；账单、原件只存 `card_id`，显示时用 `finCardFind(id)` 回查卡名，改名后老记录跟着变。
- **金额一律财务格式**：`finMoney()` = 千分位 + 两位小数（`1,000,000.00`），列表 / KPI / toast / 账户余额都用它，别再写 `toLocaleString` 或 `toFixed(0)`。金额输入框必须带 `data-money="1"`（`type="text"` + `inputmode="decimal"`）：不聚焦时显示 `1,000,000.00`，点进去自动变纯数字，失焦再格式化；**读值一律 `moneyNum()`**（能吃掉逗号），否则 `+el.value` 会得到 `NaN`。提交给 API 的仍是数字。数字量（吨 / 品位 / 人数）继续走 `num()` / `prodNum()`。CSV 导出例外：保留纯数字 `toFixed(2)`（不带逗号），免得表格分列错位。
- PWA：`/manifest.webmanifest`、`/sw.js`、`/icon-192.png`、`/icon-512.png` 由 worker 直接返回（嵌入 `worker.js`），不占静态资源路由。

### 银行水单（独立模块「银行账单」，财务组）

- 独立页（`bankPane()` / `bankPageHtml()` / `bindBank()`），路由 `#bank`；财务页底部只留一个「打开」入口（`data-go="bank"`）。模块目录在 `worker.js` 的 `MODULES` 里注册（`k: "bank"`）。模块名是**银行数字账单**（`MODULES` 里 `k:"bank"`，`t:"银行数字账单"`），风格刻意跟「银行原始单据」的档案目录区分开：卡是横向 pill（`[data-bkcard]`，默认打开第一张，公司卡在最前），上面是深色头 `bkd-hero`（卡名 + 已核笔数 / 最近期末 / 月数 + 待核角标），月份是台账行 `bkd-mrow`（左月份、中间核对进度条、右期末 + `›`），点进去是账单卡 `bkd-sheet`（左色条 + 期初/进账/出账/期末四格 + 进度条 + 看流水 / 删除），`[data-bkpath="card"]` 回到月份台账；`BANK_CARD` / `BANK_MONTH` 记路径，失效自动回退。旧版本（`old=1`）默认**折叠**成一行 `[data-bkold]`（`BANK_OLD` 控制展开），否则同一期间会同时看到两张几乎一样的单子，跟外层「N 份」对不上。另外 `POST /fin/bank` 的覆盖判定是 `uid + card_id + pf + pt`（只顶同一张卡同一期间），前端 `finBankDigitize()` 发现同一 `doc_id` 已有当前版本时先 `confirm`（取消就打开已有的那条），避免重复数字化堆历史版本。月份行 `[data-bkmonth]`，账单卡里 `[data-bankopen]` 打开逐笔核对、`[data-bkdel]` 删除；面包屑 `bkBread()` 的 `[data-bkpath]` 回上一级 / 根。月份目录就是为了月份多了不把页面淹掉。删除只给 `FIN.bankAll`（管理员 / 财务 / 负责人）渲染，服务端 `DELETE /fin/bank/:id` 同样 403 兜底；然后才是原来的行内信息：行首显示「几月到几月」（`bkRange()`：同月只写 `2026-09`，跨月 `2026-09 → 2026-10`，小字补 `09-01→09-30`）；上传弹窗解析完在期间输入框下面写一行「识别到期间：2026-09（2026-09-01 → 2026-09-30）」（`span()`）；**这一页只读，没有上传入口**（唯一上传入口是「银行原始单据」）：账单只能由原件「数字化」（`finBankDigitize()` → `finBankSheet(doc)`）产生，`finBankSheet` 从 doc 进来自动把 `doc.card_id` pin 成 hidden `#bk_card`，`pickCard()` 在 pin 时直接返回，不再让用户选卡。行上写源文件名（`s.doc_id` 回查 `FIN.docs`，`bankPane` 会用 `/fin/bankdocs` 补这份清单，拿不到就不显示）+ 期间 + 笔数，按钮是「看流水」和「删除」（`FIN.bankAll` 才渲染删除）。卡已删 / 未挂卡的账单落「没挂到卡的账单」；同期间重传的旧版本在同一月份里以 `dim` 显示。
- 解析全在浏览器：`bankParseText()` 认期初/期末/账号/币种/期间，按「上一行余额 − 本行余额」定借贷；首行日期 > 末行日期时自动 reverse 成从旧到新。逐笔只在弹窗里改，点保存才写 D1。
- 定位：**按日期把账单一笔笔列出来，人眼逐笔核对**（不做自动配对，不求跟费用记录对齐）。
- 详情弹窗 `finBankOpen()`：按 `d` 升序（同一天保持录入顺序）列出「日期 / 摘要 / 进或出 / 余额」，逐行「☐ 待核 → ✓ 已核」+「不管这行」，改动先攒在内存，点「保存核对」一次性 `POST /fin/bank/:id/tx`；全部核完自动把水单 `status=checked`。
- 期初 + 进 − 出 = 期末 由页面现算（`bk-chk` 条），和水单期末对不上就标红提示，用来发现解析错行/漏行。
- `fin_bank_stmt` 的列表查询统一走 `FIN_BANK_SEL`（带 `ok_n` 和 `gap`），`/fin` 树和 `/fin/bank` 列表都用它；`gap` = 期初 + 逐笔进 − 逐笔出 − 表头期末，列表行据此打「⚠ 缺行」。加字段时**两边一起改**，别只在 `/fin/bank` 里算——页面用的是 `/fin` 树里的 `FIN.bank`。
- 列表行右侧「0/6」= 已核笔数 / 总笔数（`ok_n` 由 SQL 子查询算，别在前端遍历）；顶部**不放大汇总**（各账户各管各的，合并没意义），也没有「全部 / 我的」切换——可见性由 `bankAll` 在服务端定。
- 后端两张表：`fin_bank_stmt`（一张水单）+ `fin_bank_tx`（逐笔，`state` = `new` / `matched` / `ignored` 正好对应 待核 / 已核 / 不管），原件进 R2 的 `bank/` 前缀；端点 `/fin/bank*`。可见性：`bank`＝自己名下，`bankAll`＝财务负责人 / admin / manager。
- 上传**只认卡**：`POST /fin/bank` 必须带 `card_id`（`finCardAny()` 反查主体，`uid` 跟着卡走），银行 / 账号 / 币种由卡派生；`PATCH` 换卡同样用 `card_id`。前端从卡的目录进来时卡已写死，只有通用入口（`finBankSheet()` 无第三参数）才给下拉选卡（`finCardOpts()`），水单解析出的账号只用来预选卡（`pickCard()`），**不能新建卡**。员工只能选自己的卡，`bankAll` 可选全部；没登记卡时弹窗给「先去财务账目设置登记」的提示。
- 同 uid + 同期间重传 → 旧记录标 `old=1` 留着（列表显示「旧版本」），不做覆盖。
- 改完跑 `node ops/test/local.mjs`：里面用页面里同一段解析代码跑两份样例（FCB 倒序 / IZB 正序）做回归，另有上传/核对/分权/删除的接口用例。另有两例覆盖真水单的坑：IZB 的余额会换行（金额在上一行末尾、余额单独一行）、摘要跨 3 行；少了尾巴时 `warn` 必须报「借方合计对不上」。
- 想离线复现真 PDF 的解析：`pdfjs-dist` 的 legacy build 在 node 里能跑（`import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"`），把 `bankPdfText()` 那段逻辑抄过去即可；`pdftotext -layout`（Poppler）也能抽文本，但行切分跟 pdf.js 不完全一样，只能当参照。
- `deploy.py` 结尾 `os._exit(0)` 会丢掉重定向里的缓冲输出 → 看不到日志时用 `python -u ops\deploy.py --code-only`。

### 银行原始单据（独立模块「财务 › 银行原始单据」，`k: "bankdoc"`）

- **两层分工不许混**：`fin_bank_doc` = 原件档案（R2 `bankdoc/{YYYY-MM}/{sha256}.{ext}`，只读证据，软删不删字节）；`fin_bank_stmt` = 从原件读出来的数字。指针在账单侧 `fin_bank_stmt.doc_id`，一份原件可以数字化成多张账单（一份 PDF 含多账号）。
- 路由：`GET/POST /fin/bankdocs`（`POST` 必须带 `card_id`，银行 / 账号 / 币种从卡派生，不选卡 400；`PATCH` 可换卡）（列表带 `stmt_n`、`?period=YYYY-MM`、`?csv=1` 导清单）、`GET /fin/bankdocs/:id/file[?dl=1]`、`PATCH/DELETE /fin/bankdocs/:id`。`POST` 服务端算 SHA-256：同主体同 hash 直接返回 `{dup:true}` 不新建；同主体 + 同银行 + 同账号 + 同月份重传 = 新版本（旧的 `old=1`、`replaced_by` 指新的，原件永不覆盖）。
- 权限：模块 `adminOnly`，但 `modsOf()` 额外给 `role==="finance"` 和 `FIN_OWNER`（员工完全看不到）；API 侧 `bankAll` 才能读/传/改，`DELETE` 只有 `isAdmin`。
- 数字化：`finBankDigitize()` 取 R2 原件 → `bankPdfText()` 本机解析 → 复用 `finBankSheet(doc, file)`，期间按月份预填，保存时带 `doc_id` 且**不重传文件**。
- 页面是**三级目录**（`BDOC_CARD` / `BDOC_MONTH` 记路径，失效自动回退；没有全局汇总数字，原件按账户各管各的、不合并）：一级账户 → 卡（`[data-bdcardopen]`，只显示卡 + 月数/份数/未数字化），二级卡 → 月份（`[data-bdmonth]`，每月一块：份数 / 未数字化 / 该月占用），三级月份 → 原件行（`[data-bdocopen]` 打开文件，右侧 下载 / 数字化 / 删除）；面包屑 `bdocBread()` 的 `[data-bdpath]` 回上一级或根。**没有全局「＋ 上传原件」**：上传只在卡（或月份）里，`finBankDocSheet(cardId)` 把卡写死在 hidden `#bd_card`，导出清单的链接放在页面底部说明行里；每张卡右上角「上传原件」直接 `finBankDocSheet(cardId)`，弹窗里只显示这张卡、`#bd_card` 是 hidden input，**用户不再选卡**；顶部「＋ 上传原件」仍可开带下拉的通用弹窗。卡已删/未挂卡的历史单据落在「没挂到卡上的原件」一栏，不会被藏掉。
- 页面是**两级目录**：一级按账户所属人（公司账户在最前，其余按姓名），二级按卡，原件挂在卡下面（`bankDocPageHtml()` 里用 `FIN.accounts[].banks` 生成 `[data-bdcard]` 块）；每张卡右上角「上传原件」直接 `finBankDocSheet(cardId)`，弹窗里只显示这张卡、`#bd_card` 是 hidden input，**用户不再选卡**；顶部「＋ 上传原件」仍可开带下拉的通用弹窗。卡已删/未挂卡的历史单据落在「没挂到卡上的原件」一栏，不会被藏掉。
- 老数据：`finSchema()` 启动时把 `fin_bank_stmt.file_key` 非空的旧水单回填成 doc（同 key 不复制文件，id 用 `d` + stmt id 后 12 位，幂等）。
- 账期起点：`FIN_START = "2026-11-01"`（worker + 页面各一份），报表 `opening.date` 默认值、新建/初始化账户的 `since` 默认值都落这天。

### 费用记录：现金 / 银行两本账（`k: "fin"`）
- 口径：**现金 = 人录，唯一来源是人**；**银行 = 账单为准**，人先预录。`fin_entries.acct`（`cash`|`bank`）+ `card_id`（只有银行账用），老记录按 `ch` 回填，`ch` 留着兼容。
- 页面顶部「💵 现金 / 🏦 银行」分开看；银行按卡分块，卡头给「期初 / 账面 / 账单期末 / 差额」，没挂卡的历史记录落「未指定卡」一栏（能补卡）。
- 记账表单选「银行」才出现卡下拉：这户只有一张卡就自动带上；没登记卡先存「未指定卡」，核销时再补。
- `state`：`recorded`（待核）→ `linked`（已对上）→ `confirmed`（当事人确认）→ `reconciled`（财务核销）；`src`：`manual` | `auto` | `stmt`。目前只写 `recorded`/`manual`，核销是下一步（P2）。
- 统计口径（待定稿，改动前先问）：银行账只算已核销，现金账全算，预录只进「预计余额」。
- 期初：现在 `fin_accounts.cash/card` 是「人填的」，和账单 `open_bal` 对不上（公司差 6,500、frank 差 45,684），下一步要用「每张卡期初 = 最早一期账单 open_bal」重设并留痕。

### 公司动态：图片 + 视频（`k: "status"`）
- 图片走 `finUpload` → `/api/fin/photo`（先 canvas 压到 1280 再转 JPEG）；**视频不能走这条**（会被画成静态 JPEG），走 `POST /api/feed/v`：请求体就是原文件，`content-type` 必须是 `video/mp4|quicktime|x-m4v|webm|3gpp`，上限 60MB，直接 `R2.put` 流进 `feed/YYYY-MM/<uuid>.<ext>`。
- 播放地址统一 `/api/fin/photo/<key>`；这个 GET **必须支持 Range**（206 + `content-range`），否则 iOS Safari 点开黑屏、安卓拖不动进度。改它之前先想清楚。
- 发/改动态的 `photos` 字段是 `[{t:"i"|"v", u:key}]`，最多 9 个；老动态里 `t:"v"` 的是旧 media worker 的外链。
- 删动态会顺手删掉它自己的 `feed/` 对象（`feed/old/` 是包内资源，不动）。
### 期间（几月到几月）
- 原件 `fin_bank_doc` 也有 `pf` / `pt`（不只是 `period` 归档月）：上传弹窗收「归档月份 + 期间起/止」，没填就按归档月补整月；`pf > pt` 直接 400。
- 数字化时把账单读出来的真实区间**回写**到原件（整月默认值 `pf=period||'-01'` 会被覆盖），所以原件行显示的区间就是账单的区间；归档月份不跟着改，用户选的目录不动。
- 两页都按「月份 + 起止」显示：原件行 `2026-11 · 11-01 → 11-13`，卡 / 月目录带区间汇总；数字账单卡头 `2026-09` + `09-01 → 09-30`，月份台账行也带区间汇总。`bkSpanCn()` / `bkSpanOf()` 是统一格式（`MM-DD → MM-DD`，别用中文，否则 i18n 检查会报未包 `tr()` 的中文）。
- `GET /fin/bankdocs?csv=1` 的清单里带「期间起 / 期间止」两列。


### 交付前的口径（审计后定稿，别改回去）
- **原件去重按「主体 + 卡 + hash」**：一份 PDF 里可能有几个账号，同一个文件挂到另一张卡时必须各建一条档案（R2 同一个 key，不重复存字节）。
- **原件上有账单就不能删**（`POST` 会 409）：先删账单再删原件，保证「每张账单的出处都在」。列表里返回 `stmt_n`（当前版本数，显示「已数字化 N」）和 `stmt_all_n`（含历史版本，决定删除按钮锁不锁）。
- **数字化先认原件再落库**：`doc_id` 认不出来（不存在 / 别人的 / 另一张卡的）直接 400/404，**不能先插账单**——老实现会留一条空账单并把当前版本顶成 `old=1`。
- **期间成对校验**：原件 `PATCH` 和账单 `PATCH` 都校验 `pf <= pt`、格式 `YYYY-MM-DD`；原件改期间用「改期间」弹层（`finBankDocEditSheet`），归档月改了会退回上层目录。
- **原件文件读取**：管理员 / 财务看全部；账单的主人（`doc.uid === 本人`）也能看自己那份（财务替他数字化出来的），整份档案清单仍然只有管理员 / 财务拿得到。
- **上传弹窗**：归档月份默认本地时区当月；没手动挑月份时按「期间止」那个月归档（`monthTouched`）；多文件上传失败会把第一条错误原因带出来；只重复没新增时提示「之前已经归档过了」。
- **只剩历史版本的月份仍然有入口**：月份列表把 `old=1` 的行算进去，月行显示「历史版本 N 份」，点进去只能看到历史版本（否则那批行永远点不到、也删不掉）。删掉当月最后一张当前版本时 `bankMonthBack()` 退回月份列表。


## 4. 不变式（不许动）

- **`login` 是关联键**（`fin_entries.uid`、`todos.owner`、`todo_notes.uid`…）。改名走 `renameLogin()`，**不要直接改 D1 的 login**。
- 人员**软删**：`deleted=1`、清会话、login 改 `<原>#del<id>`；不能删自己、不能删最后一个管理员。
- **待办完成权**：只有创建人能确认完成；执行人只能「提交完成」→ 创建人审核通过才 `done`；自排任务（creator=owner）提交即完成；公司事项管理层提交即完成；非创建人 `PATCH status=done` 一律 403。
- 待办删除只给 `creator` / `admin`；汇报只认 `owner`（admin/manager 也不能代报）。
- 打卡迟到/早退只认本人本地的 `in_hm / out_hm`（服务端 UTC 不算钟点）。
- 附件/照片只收白名单 MIME、≤25MB；HTML/SVG 一律 `attachment` 回，不在本域执行。
- **记账只记自己**：`POST /fin/entries` 的 `uid` 一律取本人（传别人直接 403），权限再大也一样；
  唯一例外是公司账户 `__company`（只有 `finance` / `admin` / 负责人能往里记）。调拨 / 备用金的
  出方也只能是自己或公司账户。**删只能删自己的**（公司账户看 `canCo`，财务负责人例外）；
  改别人的记录时**金额、收支渠道、转入方锁死**（403），只能改分类 / 备注 / 发票 / 日期。
- **公司账户 `__company`**：只有 `finance` / `admin` / 负责人能直接把费用记在公司账上（`canCo`），
  管理层和员工记账会被 403。公司账户只有银行口（选中后渠道锁死为「银行」）。对账基准
  （对账日 + 银行余额）仍只有负责人能改。
- **账目可见范围**（`finVisible`，worker.js）：管理员 / 财务 / 财务负责人看全局；负责人看
  「负责人 + 员工」的账（人员列表、账户余额同样只到这一层）；员工只看自己的。跨层的记录
  （如管理员 → 员工 的转账）只要涉及这一层的人就可见，改 / 删 / 补票仍需落在可见范围内。

## 5. 环境约束

- QGIS 4.2.2 用 `"C:\Program Files\QGIS 4.2.2\bin\python-qgis.bat" script.py`；系统 python 无 gdal/shapely，**别 pip 装**。
- 改了缓存内容必须 bump `sampling_sw.js` 的 `CACHE`（`sampling-vNN`），否则老客户端不更新。
- QGIS 不监视磁盘上的 `.qgz`：外部改完要「关 QGIS → 不保存 → 重开」。

## 6. 未完成 / 待办（动手前先问）

- 矿证模块搬迁：`ops/licence.html` + `/_lic/*`（D1 状态 + R2 媒体）未接完。
- 首页「矿证」快捷入口仍指向外部 mine-sync。
- 公司模块：搜索收纳 + 新建时选资料。

## 7. 踩过的坑（别再踩）

- **`deploy.py` 任何不认识的参数都会走完整部署**（`--help` 也不例外：apply_schema + migrate + 上传 + 换 `SETUP_TOKEN`）。
  只更新代码用 `--code-only`，只看状态用 `--status`，别拿它试参数。
- **不要用 PowerShell `Get-Content`/`Set-Content` 改写含中文的源码**：默认按 ANSI 读，写回就是乱码。
  改文件用编辑器或 python（`encoding="utf-8"`、`newline="\n"`）。
- 线上源码可从 `ops/dist/worker.js` 反解：跳过开头 `globalThis.__OPS_PAGE__ = "…"` 和
  `globalThis.__LIC_PAGE__ = "…"` 两个赋值，剩下的就是 `ops/worker.js` 原文（与线上一致）。
- **登录限速**：`login_fail(k, at)`，`k = 账号|cf-connecting-ip`；10 分钟内满 5 次锁 10 分钟
  （429 + `Retry-After`），登录成功按该键清零。要立刻解锁某人，删对应行即可。
- 改完 worker 的顺序：`node ops/test/local.mjs` → `python ops/build.py`（会刷 BUILD 时间戳）→ 部署。
  `local.mjs` 用 node:sqlite + 真 HTTP 跑真 Worker，没有 mock。

- **R2 的 `put()` 只收「已知长度」的流**：把自拼的 `ReadableStream` 交给 `env.PHOTOS.put()`，线上直接
  500（`Provided readable stream must have a known length`），而本地假 R2 不会报——所以分片合并必须包
  一层 `new FixedLengthStream(total)`（见 `feedVidAssemble`）。这就是 2026-11-13 用户 78MB 视频
  「分片都传上去了、最后一步失败」的真因。
- **视频上传链路**（`/api/feed/v/*`）：客户端 4MB 分片（`fdUploadVideo`）→ `PUT /part` 写
  `feed/tmp/<uid>/<i>` → `GET /status` 问服务端已到位哪几片（刷新/换设备可续传）→ `POST /finish`
  （校验总字节 == 声明大小、FixedLengthStream 按序拼接、写 `feed/done/<uid>` 幂等标记，重发直接拿回 key）
  → `POST /abort` 放弃。`feed/tmp` 与 `feed/done` 过期 3 天由 `feedVidGc` 清掉。
- **删媒体统一走 `feedMediaPurge`**：删动态 / 编辑去掉附件 / 删账目照片都会先查 `posts` + `fin_entries`
  的引用，只删「谁都不再用」的；`feed/old/` 是包内资源永远不动。不要改回直接 `PHOTOS.delete`，会误删共用图。
- **图片/视频体积上限**：单次直传 ≤ 8MB 走 buffer，更大走 4MB 分片；总上限 90MB（`FEED_VID_MAX`），
  分片数上限 24（`FEED_VID_PARTS`），两边要一起改。
- **QA 探针账号** `_qa_upload_probe` 用完必须删（`DELETE FROM users WHERE login='_qa_upload_probe'`），
  并清掉它在 R2 里留下的 `feed/2026-*/*`、`feed/tmp/*`、`feed/done/*`。
