# 仓库须知（给后续 agent）· 精简版

单文件离线 PWA 集合 + Cloudflare Worker 后端；发布在 GitHub Pages / Workers。改完直接刷新页面。

> 本文件 = 「地图 + 硬约束 + 当前状态」，不是实现手册。细节直接读源码；旧版全文在 git 历史里可查。
> 原则：**先读真实文件核对，再动手**；只保留最近的当前状态，过期细节不进这里。

## 一、硬约束（踩过的坑，别再犯）

1. **编码**：PowerShell 5.1 内联中文/JSON 会乱码 → 一律写 `.py` 文件再跑，脚本里 `sys.stdout.reconfigure(encoding="utf-8")`。
2. **地理库**：QGIS 4.2.2 的 Python 用 `"C:\Program Files\QGIS 4.2.2\bin\python-qgis.bat" script.py`；系统 python 3.14 无 gdal/shapely，**不要 pip 装**。
3. **GDAL**：`ogr.Open(p).GetLayerByName(x)` 链式会让临时 DataSource 被回收 → 先把 DataSource 存变量。
4. **QGIS**：不监视磁盘 `.qgz`；外部改完必须「关 QGIS → 不保存 → 重开」。
5. **SW 缓存**：改任何缓存内容必须 bump `sampling_sw.js` 的 `CACHE`（`sampling-vNN`），否则老客户端不换。
6. **版本号**：`py -3.12 devtools/bump_version.py` 同步 `APP_VER` / `CACHE` / `version.txt`。
7. **Cloudflare 部署**：命令里必须出现 `CLOUDFLARE_API_TOKEN` 键名，系统才会注入 token。
8. **别用 PowerShell 改文件**：`Get-Content`/`Set-Content` 循环改 UTF-8 文件会按 GBK 读坏中文（不可逆）。改文件用 file_editor，或 python `io.open(..., encoding="utf-8")`。

## 二、结构地图（一行一个）

- `sampling_helper.html` — 取样工具（全前端单页，离线 PWA）。
- `licences.html` — 赞比亚矿权介绍（单页应用）。
- `sampling_sw.js` — 离线缓存 SW。
- `areas.json` — 矿区 bbox；`licences.json` — 矿证；`samples.json` — 取样点导出。
- `geo_packs/` — 离线地质包（瓦片/图片）。
- `ops/` — 运营工作台 + 财务（**当前重点**，见第三节）。
- `devtools/` — 版本/导出/导入脚本；`_deploy/` — 部署素材（含媒体 worker 源）。

## 三、ops/ 运营工作台（ecobox-ops）· 当前重点

**构建 / 部署**

- 源码 `ops/index.html` + `ops/worker.js` → `python ops/build.py` → `ops/dist/worker.js`（页面内联进 worker）。
- Worker `ecobox-ops`；account `dff446b2b98a38ac2b82263e3ff14da9`；D1 `9c9f6539-a564-461c-8ba8-e04a2f7eb198`；R2 `ecobox-finance`（binding `PHOTOS`）。
- URL：`https://ecobox-ops.frankataix.workers.dev/`

**数据表**：`users` `sessions` `logs` `posts` `fin_entries` `fin_accounts` `fin_cfg`

- `fin_entries(id, uid, by_name, date, kind, cat, ft, ch, amount, note, photos, to_uid, to_ch, created_by, created_at, legacy_id)`
- `fin_accounts(uid, name, cash, card, since)`；`fin_cfg(k, v)`

**目录页（home）**
- 每张卡片右上角 ★ 可设/取消「快捷」（= 置顶）；存在 `users.shortcuts`（JSON 数组，顺序即显示顺序），走 `PATCH /api/me {shortcuts:[...]}`，非法/重复键被服务端丢掉，最多 8 个。
- `homeHtml()` 的分组顺序**跟顶部页签一致**（`GROUPS` 常量），配置里新出现的分组追加在最后；卡片统一由 `modCard()` 渲染（含星标），分组页复用同一个渲染器。
- 星标点击由 `#pane` 的**捕获阶段**监听器处理（`stopPropagation`），所以点星标不会进模块、也不会跳外链；监听器只绑一次（`pinBound` 防重复绑定，否则会一置顶一取消）。

**待办（`/api/todos`，`todos` + `todo_notes`）—— 派活即归属 + 每日汇报**
- 三个范围 `scope`：`self` 自己给自己排（`self_set=1`）、`person` 派活（必须指定 `owner`，服务端校验用户存在，`owner_name` 冗余存姓名）、`company` 公司事项（可空执行人，谁都能跟一句）
- **归属在创建那一刻定死**：`POST` 直接写 `status='doing'` + `started_at` + `assign_at`，并在时间线写一条 `kind=assign`（「指派给 X」/「自己给自己排的任务」/「公司事项，大家一起跟」）。**没有「开始执行」这一步**，不存在「谁点了就归谁」
- 状态只有 `doing` / `done`；`PATCH` 传 `status:'todo'` 一律当 `doing`（兼容老前端）。建表时会把历史 `status='todo'` 的行一次性并进 `doing`
- 每日汇报：`POST /api/todos/:id/report`（`/start` 是别名）`{text?, flag}`，`flag` = `progress|blocked|idle`；**`text` 可选**，不写就按 flag 补「有推进 / 卡住了，需要支持 / 今天没动」；写入 `todo_notes.kind=report, flag=...` 并更新 `last_report_at / last_report_by / last_flag`
- **汇报只认归属人**（`owner`），`admin`/`manager` 也不能替员工报（否则「日日汇报」就假了）；公司事项没 `owner` 时谁都能跟一句，但只记 `kind=cmt`，**不动归属、不算某人汇报**
- 改派：`PATCH {owner}` 换人时 `last_report_at/last_report_by/last_flag` 清零、`assign_at=now`，时间线记「改派给 Y，汇报重新开始」——别拿上一个人的记录充数
- 前端：卡片显示汇报状态（`今天已汇报` / `N 天没汇报`，`reportedToday()` / `reportAge()`）；执行人看到「📝 汇报」按钮，弹层三个一键按钮（推进了/卡住了/今天没动），点一下就算报过，文字选填
- 页面结构 `todoHtml()`：**置顶统计 `statsBoard()`**（`.td-board`，所有人可见，自己排第一：未完成 / **未跟踪 = 今天还没汇报** / 逾期，行可点 = 筛选那个人 `p:<login>`）→ KPI 四个数（我负责 / 今天未汇报 / 已逾期 / 7 天内到期，都可点筛选）→ 主动性条（`.td-selfbar`：自派几项 + `reportStreak()` 连续汇报天数）→ `TODO_FILTERS` 计数筛选 → 分组（📝今天还没汇报 / ★重要 / ⚠已逾期 / 今天到期 / 接下来 / 无截止 / ✓已完成）
- 派活权限：**只有 `admin` / `manager` 能派给同事**（`canAssign()`；服务端 `POST` 拦 `scope=person`、`PATCH` 拦换 `owner`，403），弹层里员工只看到「我自己」；员工编辑别人派的活时不提交 `scope`，避免把归属改回自己
- 逾期/未汇报提醒：待办页顶部红条（`.td-alert`）、首页待办卡片红点（`lateForMe + needReport`）、**每天首次打开工作台弹一次**（`maybeLateAlert()`，先列我的「今天还没汇报」再列「已逾期」，管理层最后一块「同事今天还没汇报」按人计数，localStorage `tdal_<login>_<date>` 去重）；`showApp()` 里预载 `loadTodos()` 才有这些数
- 权限：`owner` 和 `creator` 能改状态/标题，`admin`/`manager` 全能改；**删除只给 `creator` 和 `admin`**（执行人不能删别人派的活）
- `imp=1` = 重要（前端 ★ 置顶段）；`due` 只收 `YYYY-MM-DD`
- 建表在 `todoSchema()` 里用 `CREATE TABLE IF NOT EXISTS` + ALTER 兜底跑，跟 `fin_entries` 一样靠首次请求自迁移（部署脚本的 D1 校验接口没权限，403 属正常）
- **附件**（「每一项都能挂文件」）：`todos.files` 存 JSON 数组（`k/key/mime/size/name/at/by/by_login`），实体在 R2 `todo/<id>/<k>.<ext>`
  - `POST /api/todos/:id/file` `{data: dataURL, name}`，`GET /api/todos/:id/file/:k`（也认 `?k=`），`DELETE /api/todos/:id/file/:k`
  - 只收 PDF / 图片 / Office / `text/plain|csv` / ZIP（`TODO_MIME`），单个 ≤ 25MB（超了前后端统一提示「文件超过 25MB，请线下提供（U 盘 / 网盘 / 邮件）」，别让用户以为重试能过），每项 ≤ 20 个；**图片和 PDF 内嵌预览，其它一律 `content-disposition: attachment`**，避免 HTML/SVG 在本域执行
  - 谁能传：`mine || admin || manager || (公司事项且没 owner)`，跟留言一个口径；无关同事只能看/下载
  - 前端：卡片展开区（`.td-atts`）里「＋ 附件」多选上传、文件名可点开、× 删除；卡片底部 `📎 N` 计数。`tdMime()` 按扩展名补 MIME（浏览器给的 `file.type` 常为空，尤其 .docx/.xlsx）

**打卡（`/api/att`，`att_cfg` + `attendance`）—— GPS 围栏 + 两段打卡**
- 办公点与班次存 `att_cfg`（单行，`id=1`）：`lat/lng/radius/site_name/start_t/end_t/grace`；只有 admin 能改（`PUT /api/att/cfg`）。
- 每人每天一行（`PRIMARY KEY(uid,d)`），`uid` 存 **login**；`in_at/out_at` 是 ISO 瞬时，`in_hm/out_hm` 是**本人本地** `HH:MM`（迟到早退只认它，服务端是 UTC，不能拿 `in_at` 算钟点）。
- `d` 与 `hm` 由前端给（`localDay()` + `toTimeString()`）；服务端只做格式校验与兜底。
- `POST /api/att/punch {lat,lng,acc,d,hm}`：`phase` 依次 `in → out → done`；`attMeters()` 算球面距离，超出 `radius` 回 409；同一天 `out` 与 `in` 相隔 < 1 分钟也 409（防误触）；两段都必须在范围内。
- `GET /api/att?ym=YYYY-MM&d=YYYY-MM-DD[&all=1]` 回 `cfg / todayRec / phase / records / stats{days,late,early,miss,hours}`；`all=1` 仅 admin（全公司）。
- 统计口径：`late` = `in_hm > start + grace`；`early` = `out_hm < end`；`miss` = 有上班没下班；工时 = `out_at-in_at` 累加。
- 前端：`punchPane()`（`ATT` 状态），`gpsFix()` 取定位；管理员的「打卡设置」卡可直接「用当前位置」填经纬度。

**客户（`/api/customers`，`customers`）**
- 单表档案：`name` 必填，其余 `contact/phone/email/wechat/country/addr/bank/swift/accNo/currency/note`。
- `GET`（`?q=` 匹配名称/联系人/电话/邮箱/国家）· `POST` · `PATCH :id` · `DELETE :id`；`id = "cu" + base36`。
- 列名 `acc_no`，接口/前端一律 `accNo`（`CUST_FIELDS` 用 camel，写库时映射）。
- 前端 `customerPane()`（`CUST`）：搜索 + 列表 + 卡片内联表单，删前 `confirm`。

**出口（`/api/exports`，`exports`）—— 7 段流程**
- 阶段常量 `EXP_STAGES = applied → moses → analysis → valuation → royalty → permit → exported`，`EXP_LABEL` 给中文；数值 `status` 只前进不回退（`Math.max(当前序号, 本段序号)`）。
- `stages` 存 JSON `{stage:{at,by,...自定义字段}}`；`POST /api/exports/:id/stage {stage,fields}` 只允许 `[a-zA-Z]\w{0,20}` 的键。
- `files` 存 JSON `[{k,stage,key,name,mime,size,at}]`，实体在 R2 `export/<id>/<stage>/<k>.<ext>`；走 `POST/GET/DELETE /api/exports/:id/file`（dataURL 上传，PDF/图片，≤25MB，每单 ≤60 份）。删单时连 R2 对象一起删。
- 前端 `exportPane()`（`EXP`）：列表按状态点亮 `.st-dot`，展开即 7 段表单 + 每段「标记完成 / 更新本阶段 / ＋上传文件」；`EXP_STAGE_FIELDS` 定义每段要填什么。
- 没做的：原应用的「读 PDF 条码自动建单」还没搬（需要 pdf 解析，另行安排）。

**人员接口**（`/api/users`，仅 admin）
`GET` 列表（只列 `deleted=0`） · `POST` 开通 · `PATCH :id`（姓名/账号/电话/角色/密码/模块） · `DELETE :id` 删除

**账号名 `login` 是关联键**：`fin_entries.uid` / `to_uid`、`fin_accounts.uid`、`todos.owner`、`todo_notes.uid` 存的都是 **login（不是 user.id）**。改名时 `renameLogin()` 会把它们一起搬过去（`PATCH /api/users/:id` 回 `{ok,moved}`，搬不动会回滚改名并 500）；历史遗留「挂在已不存在 login 下的记录」由 `GET /api/fin/bootstrap` 的 `orphans` 报出，财务页顶部显示「这些记录挂在旧账号名下 · 并到我名下（N）」，点击走 `POST /api/fin/remap {from,to}`（仅 admin）。**别直接改 D1 里的 login**。

**导航：模块＝独立页（2026-11 用户定，别改回去）**

- 「目录 / 动态 / 分组页」是**根页面**，保留顶部页签 `#tabs`；**每个模块都是独立页**：进页隐藏页签，顶部只剩「← 标题」，靠返回出去（以「费用记录」为样板）。
- 规则集中在一处：`ROOT(t)` 判定根页面 + `syncChrome()` 切页签/返回/标题；`enterApp(k)` 压栈 `S.stack`、`history.pushState('#k')`、滚到顶、置 `S.fresh` 触发进场动画；`goBack()` 弹栈回原页并用 `replaceState` 对齐地址；浏览器/Android 手势后退由 `popstate` 兜住。
- 新模块只要 `/api/modules` 里带 `tab`，**自动**就是独立页（标题取 `MODS` 的 `t`）；**不要再**把模块渲染成页签，也不要在页面里自带标题栏。
- 外链工具（配置里用 `u` 不用 `tab`）照旧新窗口打开，不受这条约束。

**岗位（`users.role`）**：`staff` 员工 / `manager` 负责人 / `finance` 财务 / `admin` 管理员

- 员工：只看/只改自己录的日报；财务能看全部账、替任何人记账、标票、登记转账，但不能改余额/分类/期初（负责人专属），也不能改别人的日报、不能管账号；负责人＝员工权限 + 全部日报；管理员＝全部 + 账号/备份。

- 人员**不挂矿区**：`users.site` 只作历史字段保留，页面不再读写。
- 删除是**软删**：`deleted=1`、`active=0`、清会话，并把 `login` 改成 `<原账号>#del<id>` 腾出名字；他录的日报/账目仍按原 `user_id` 关联，`logs` 的 JOIN 名字照常显示。不能删自己，也不能删掉最后一个可用管理员。
- 人员页是**卡片列表**（`.ulist` / `.ucard`）：桌面 `auto-fill` 多列、手机 ≤640px 单列 + 40% 宽按钮，不用表格横向滚动；每卡「权限 / 编辑 / 改密码 / 停用|启用 / 删除」，编辑为卡内联表单。

**语言（中文 / English）**

- `users.lang`（`zh` 默认 / `en`）；`PATCH /api/me {lang}` 改，只认 `zh|en`。前端另存 `localStorage.ops_lang`，登录后以账号值为准。
- 「系统」分组下「语言」模块（`{k:"lang", tab:"lang", always:true}`）→ 语言页；切换时 `setLang()` 先重建导航（`buildTabs()`/`paintWho()`）再 `render()` 全量重绘。
- 界面文案：`ops/index.html` 顶部 `EN` 字典 + `tr()`；每次 `render()` 后 `applyLang(document.body)`，并用 `MutationObserver` 兜住异步插入的内容。字典里没有的中文**保持原样**（不报错）——新增界面时把中文串补进 `EN` 即可。
- 内容双语列：`posts.body_zh/body_en`、`post.comments[].text_zh/text_en`、`logs.note_zh/note_en`、`fin_entries.note_zh/note_en`。写入时 `trPair(env, text)` 调 Gemini 2.5 Flash 同时产出中英两版（原文原样存一列，另一列放译文）；展示用 `tx(obj, "body"|"note"|"text")`，当前语言缺译文就回退原文。
- 依赖 worker secret `GEMINI_API_KEY`（`wrangler secret put` / Dashboard）。没配时翻译静默跳过，只存原文，写入照常成功。
- 老数据没有译文 → 英文模式下仍显示中文原文；编辑一次该条（或带 note 重新保存）就会补上译文。

**财务接口**（前缀 `/api/fin/`）
`GET bootstrap` · `POST entries` · `PATCH|DELETE entries/:id` · `PUT entries/:id/photos` · `PUT entries/:id/inv`（补票，只改有票/无票） · `PUT accounts/:uid` · `PUT cats` · `POST cats/merge`（合并老分类，`?dry=1` 只计数） · `PUT opening` · `POST photo` · `GET photo/<key>` · `POST import` · `POST remap`

**记账类型 kind**：`out` 支出 / `in` 收入 / `float` 备用金 / `move` 取现/存现 / `transfer` 人员转账

**户模型（A：账户体系）**

- 一个「户」= `uid` × 渠道（现金/银行）。`uid = "__company"` 是**公司账户**（一级户，只有银行口），只做资金沉淀，不是人：`finPeople()` 会把它过滤掉，只出现在调拨的收付双方。
- `transfer` 是唯一的**户间调拨**：`公司账户 → 员工卡`、`frank → supeichang`、`员工 → 公司账户`（交回）都走它；`move` 是同人 card↔cash 的取现/存现；`float` 是调拨 + 预支（挂「其他应收款」）。
- 调拨不产生费用：`Σ各户余额` 只因 `out`（消费）减少，只因 `in`（注入）增加。
- 公司账户余额用 `PUT accounts/__company`（`card` + `since` 对账日）维护，对账日之前的记录不计入。
- 会计口径：公司账户 → 个人卡 记「其他应收款—个人」，不是费用；个人卡消费并拿票后才确认费用。

**费用分类（`ft` 归属 大类 → `cat` 分类 细类）**

两级联动，改一份表就改了「记一笔」的下拉（`FIN_FT` + `FIN_FT_CATS`，前端）：

| 归属 `ft` | 分类 `cat` |
|---|---|
| 生活 `life` | 交通 `transport` · 加油 `fuel` · 小费 `tip` · 餐饮住宿 `meal` · 通讯 `comms` · 办公 `office` · 员工补贴 `allow` · 生活开销 `pliving` · 维修 `repair`（车修为主） · 其它 `misc` |
| 项目 `project` | 外协劳务（包工头）`sub` · Serenje 钽铌矿项目 `serenje` |
| 矿权维护 `licence` | 矿证（待录入，走 `fin_cfg.cats.licence`） |
| 往来 `ledger` | 借款 `loan` · 家庭开支 `home` |

- **小费**：给公司外面的人（警察/装卸/看守/向导），基本无票、税前不可抵扣。
- **外协劳务（包工头）**：矿区里干活但不在公司编制的人——按项目/工作目标把一笔钱付给固定包工头，由他去发。属**服务采购成本**，不是 `员工补贴`（那是本公司工资表里的人）、也不是 `小费`（无对价）。要留合同/工作范围 + 收据，最好有 TPIN 发票，否则 ZRA 可能认定为隐性雇佣追 PAYE/NAPSA。选中时表单会提示。
- **往来 = 钱出去了但不是费用**：`FIN_OFFBOOK = { home: "私人", loan: "往来" }`，且 `ft=ledger` 一律视为往来。余额照扣、资金流水里有；但 KPI 支出、`支出汇总`、`支出明细 CSV` 都不含。流水行标「私人·不计费用 / 往来·不计费用」，KPI 下写明「私人 X · 借款 借出 X · 已还 Y」。
- **项目 / 矿权维护的自定义项**存 `fin_cfg.cats`：`{life:[], project:[], licence:[], names:{}}`，设置里「改分类」分别维护三段。
- **老分类合并**（`FIN_CAT_MERGE`，接口写入时自动纠正）：`daily/postage/other → misc`、`lodging → meal`；顺带把 `loan/home` 的 `ft` 修正为 `ledger`。设置里「合并老分类」先 `?dry=1` 报数量，确认后再改。

**必填 / 发票**（`fin_entries.inv`，0 无票 / 1 有票）

- `out` / `in` / `float` 的**备注必填**（前后端都拦）；金额必须 > 0。
- `out` / `in` 可选有发票；**选「有发票」必须至少一张照片**（POST / PATCH / PUT photos 三处都校验，删光照片会被拒）。
- 老库：`ALTER TABLE` 补 `inv`，并把「已有单据照片」的 out/in 自动标成有票。
- **补票**（`PUT entries/:id/inv`）：老记录人工逐条标有票/无票，**只改 `inv`**，不校验备注/照片（否则历史无票无照片的记录根本改不动）；前端「🧾 补票」按钮进入逐行标注模式，点一下即存、就地更新、不整页刷新；有票但没图的行显示「有票·缺图」提醒补照片。

**人员转账补充**
- `transfer`：`uid` 转出人、`ch` 转出口、`to_uid` 转入人、`to_ch` 转入渠道；转出人扣、转入人加，公司总额不变（不是花费）。
- 只有负责人/管理员能登记转账（员工看不到别人的账户，只在自己的列表里看到转入/转出）。

**权限**

- 财务负责人（`FIN_OWNER`，默认 `frank`）/ admin / manager ＝ 可改**全部**记录；
- 其他人 ＝ 只能改/删**自己**的记录（`row.uid === 本人`）；
- 发备用金（float）、改余额、对账、期初 ＝ 仅负责人。

**余额口径**

- `finAcct(uid)`：来源 − 花费 = 剩余（现金/银行分开；`move` 在 card↔cash 间搬；收到 float 计入来源、发出 float 计入花费）。
- `finFloatOf(uid)`：收到备用金 − 之后支出 = 手上剩余（备用金本身不算花费）。

**登录 / 备份**

- 登录闸门：`GET /` 未登录只返回 `LOGIN_PAGE`（最小登录页，无 app 框架 / 数据）；登录后返回完整页面。会话 30 天（`SESSION_DAYS`），登录一次即可。
- 每日备份：Cron `0 0 * * *` 触发 `scheduled()` → `runBackup()`，把 D1 全表导出到 R2 `backups/YYYY-MM-DD.json`，只保留最近 30 份。
- 手动：`GET /api/backup` 看列表、`POST /api/backup` 立即备份（仅 admin）。

**前端关键函数**：`finHtml`(渲染) · `finSheet(presetTo, presetKind, editEntry)`(记/改表单) · `finTransferSheet(editEntry, presetFrom)`(户间调拨，含公司账户) · `openFinMenu`(⋯ 菜单) · `loadFin`(拉 bootstrap) · `finUpload`(照片) · `finAcct` / `finFloatOf`(算账) · `finExport`(CSV) · `FINCO`(`__company`)

**已完成（均验收过）**

1. 独立页 + 返回目录 + 标题「费用记录」（导航一级分组仍叫「财务」）
2. 资金账户：我 / 全部 / 某人；现金 + 银行；来源 − 花费 = 剩余。时间范围用分段按钮 **今日 / 本周 / 本月 / 本年**（默认本月，本周从周一起算，选择存 `ops_fin_view.range`）——余额卡不受范围影响，KPI 与流水按范围过滤
3. 记一笔：支出 / 收入 / 取现 / 备用金；分类 · 归属 · 渠道 · 照片≤6；**金额 + 备注必填**；入口只有右下角浮动按钮（桌面/手机都显示，不再有行内重复按钮）
4. 备用金「给员工」：从谁出=本人、发给谁=所选；员工往来卡「收到 − 已花 = 剩余」
5. 行内「⋯」编辑 / 删除；管理者改全部、员工改自己
6. 照片：记一笔 / 编辑 / 取现存现都能补——「拍照」「从相册选」双入口、缩略图可 × 移除、n/6、失败有提示、可点看大图
7. 人员转账：某人 → 某人，转出/转入各自可选现金或银行；表单实时预览双方转后余额（不够标红），列表按人显示「现金 → 银行」，全部视角显示「转出 = 转入 ✓ 公司总额不变」；仅负责人/管理员能登记（员工只在列表里看到进出），编辑走同一表单
8. 操作提示条 1.2 秒自动消失（错误 3.5 秒），不再需要点一下刷新
9. 有发票 / 无发票：记一笔里二选一（`inv`），选有发票必须传票图；流水行标「有票 / 无票」；列表上方 **全部票据 / 有发票 / 无发票** 筛选（存 `ops_fin_view.inv`），支出/收入按票筛，备用金/取现/转账不受影响
10. 常用花费人 `FIN_FAV = ["frank", "supeichang"]`：所有人员下拉、账户卡、转账/备用金选择器都按这个顺序置顶（其余保持原顺序）；记在谁名下默认本人，备用金默认发给常用第二人
11. 补票：`🧾 补票` 进入逐行标注（有票 / 无票），老记录也能标（不要求备注/照片），就地保存不刷页，底部实时「本页 有票 X / 无票 Y」
12. 账户体系（A）：`🏦 资金总览`（公司账户 / 员工手上 / 公司资金总额 / 未报备用金）、`🏦 公司调款`（公司账户 → 某人，自动锁定银行口）、`🔀 调拨`（任意两户，含转回公司账户）；设置里可存公司账户对账基准
13. 报税/核对：`📊 核对与报表`（默认收起，一行摘要 `公司 X · 本月有票 / 无票`）展开后是 资金总览 + 备用金 + 调拨核对 + 支出汇总；`⬇ 支出明细 CSV`、`⬇ 资金流水 CSV`（带 BOM，Excel 直接打开）
14. 日常记账保持轻：默认「记在谁名下」= 当前登录人；分类/渠道/归属沿用上次选择（`ops_fin_last`）；发票提示只在选「有发票」时出现
15. 两级分类：**归属**（生活 / 项目 / 矿权维护 / 往来）→ **分类** 联动；生活 10 项（交通 加油 小费 餐饮住宿 通讯 办公 员工补贴 生活开销 维修 其它，维修以车辆为主），项目 = 外协劳务（包工头）+ Serenje 钽铌矿项目，矿权维护待录矿证；往来科目不计费用；老分类由「合并老分类」一次性归并

**待办**：迁移旧「ECOOBOX 公司管理」的财务数据；下线旧应用。

**公司（公司资料库，`/api/companies`）—— 「资产」板块**

- 表 `companies`：`id / name / name_en / kind / reg_no / reg_date / tpin / address / phone / email / share_capital / currency / shareholders / directors / notes / tags / docs / created_at / updated_at / created_by / updated_by`
- **股东/董事/资料存 JSON 文本**（不建子表），出入库统一走 `coApply()` / `coOut()`；前端明细页读模式只渲染只读表格
- **资料（证照 PDF）**：`docs = [{k,label,name,key,mime,size,at}]`，**文件本体在 R2**（`env.PHOTOS`，key = `company/<公司id>/<k>.<ext>`），行里只存元数据
  - `POST /api/companies/:id/doc {data(dataURL),name,mime,label}` → `201 {doc,docs}`，限 PDF/PNG/JPEG/WebP、单份 ≤25MB、每家 ≤40 份
  - `GET /api/companies/:id/doc/:k` → 文件流（`content-disposition: inline`，要登录；k 必须命中 `docs` 才给，防路径穿越）
  - `DELETE /api/companies/:id/doc?k=` → 同时删 R2 对象；删公司时连带清空该公司全部资料
  - 前端 `#company` 明细页「资料」卡片：上传（`#co_doc_up`）/ 点击预览 / `data-codel` 删除，列表行显示 `📄份数`
- 建表在 `coSchema(env)` 里用 `CREATE TABLE IF NOT EXISTS`，**首次带登录态请求自动建** → 不需要 D1 迁移，API token 缺 D1 权限也能用
- 占比：`coHolders()` 分母 = **max(注册资本, 出资合计)**（PACRA 常见「资本填面值、金额填实缴」，只按资本算会算出 949%）；`zm_pct` = 赞比亚籍股东占比之和；「占比合计」偏离 100 超 0.5 才标红
- 数据（2026-11）：**生产已入库 15 家**，来自 mine-sync `data/license_apps.json`（`POST https://mine-sync.frankataix.workers.dev/ {action:'read',path:'data/license_apps.json'}`，16 条里 1 条是自然人，跳过）。已做：`regDate` → ISO、`capital` 去千分位、国籍 Title Case、`note` + 公司秘书并入 `notes`；每家公司随附 7–8 份证照（**共 106 份 / 253.8 MB 已迁入 R2**，源为 mine-sync `/media?key=`）
- 写库通道：API token **没有 D1 权限**（`/d1/.../query` 报 7403），需要直插时临时部署一个绑定同 D1 的一次性 Worker 写，写完立刻 `DELETE /workers/scripts/<name>`（2026-11 导 15 家就是这么做的）
- **一次性 Worker 不能 fetch 另一个 `*.workers.dev`**：同 zone 互调直接 `error code: 1042` → 搬迁文件必须由本地下载后 base64 POST 给临时 Worker 落 R2（2026-11 迁 106 份资料就是这么做的，253.8 MB）
- 搜索 `?q=` 命中 name / name_en / reg_no / tags / address **+ shareholders、directors 的 JSON 原文**（所以能按股东名反查公司）
- 批量导入 `POST /api/companies/bulk {companies:[...]}`；股东 `{name,nationality,id_no,amount}`、董事 `{name,nationality,id_no,role}`；前端「批量导入」面板带「填充示例」
- 权限：读要 `company` 模块权限；写限 `admin`/`manager`；删除限 `admin`；写操作走同源校验

## 四、数据模型不变式（用户反复强调，不许动摇）

1. 取样记录只对「坐标 + 地质事实」负责；**矿证不在取样记录里出现**（不是字段/外键/必填项）。
2. 矿证 = 分析视角（多边形筛选器），不是归属；「点属于某证」**读时算**，不写时填。
3. 采集猜出的证号只作快照 `captured_*`，不参与统计/展示/导出。
4. 范围内外对比只在项目 / 矿权分析端做。
5. `area_id` = 工作区/图幅/项目（命名空间），**不是矿证**。
6. QGIS `field_samples` 无矿证字段，同步脚本也不许加。

## 五、矿权分析框架（不变式之二）

「看整体，答局部」：L0 克拉通 → L1 区域成矿带 → L2 图幅/矿区 → L3 矿权 + 缓冲 → L4 取样点。
结论载体 = 靶区台账（Target Ledger），不是散文；AI 只汇总证据与置信度，不给 go/no-go；取样点永不写入矿证归属。

## 六、其它云服务

| 名称 | 地址 | 说明 |
|---|---|---|
| 采样 API | `fancy-heart-7a80.frankataix.workers.dev` | `/ping /sample /samples /ocr`，D1 `78e80331…` |
| 媒体 Worker | `ecobox-media.frankataix.workers.dev` | `/put` `/m/<key>` `/ai/*`，源 `_deploy/worker/media-worker.js` |
| R2 | `ecobox-media` | `photos/ reports/ geo/ test/`，单文件≤6MB |

## 七、改 ops 的固定流程

1. **先读真实文件核对现状**（别信旧摘要）。
2. 改 `ops/index.html` / `ops/worker.js`。
3. `python ops/build.py` + `node ops/test/local.mjs`（真 worker + node:sqlite，`PASS=n FAIL=0` 才算过）+ `node --check ops/dist/worker.js`。
4. jsdom 测**真实需求**（不只 happy path）。
5. 部署 + `check_deploy.py` 核对 BUILD。
6. 复制到镜像仓库 `_repo/ecobox-sampling` → commit → push。
7. 定时任务（Cron）只能用 wrangler 设：`npx -y wrangler@3 triggers deploy`（配 `[triggers] crons`）；`PUT .../schedules` 用 API token 会报 10026。

> **推送坑**：直接 `git push origin main` 走本机 git 凭据管理器即可；**不要**用 `GITHUB_TOKEN` 拼进 URL（只读，403），也别用 `GITHUB_PUSH_TOKEN`（可能为空导致卡住）。

## 八、工作台产品原则（2026-11，用户确认）

- **定位**：公司内部人员用；必须登录才能看数据；核心目标 = **统一性**（把以前散在各独立模块的功能收进一个工作台）。
- **权限**：现阶段不做细粒度权限；以现有账号数据为准；全部功能做完后再统一规划权限范畴。
- **基础数据**：只有 frank（开发者）有权维护；随功能逐步补；默认币种 **ZMW**。
- **旧 App**：旧「ECOOBOX 公司管理」无关紧要，可随时关闭；**不做数据迁移优先**。
- **终端**：**手机优先**（录入/查看主要在手机），**web 用于管理**；每个模块都要手机可用。
- **质量目标**：安全、可靠、专业。
- **备份**：需要**自动定期备份**（定时导出 D1 → R2，防 bug 丢数据）。
- **推进方式**：先完善功能，再按功能补数据；模块逐个由用户布置。
- **范围**：本窗口只做 ecobox 工作台，其它诉求在别的窗口。
