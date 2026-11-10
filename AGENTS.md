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

- `fin_entries(id, uid, by_name, date, kind, cat, ft, ch, amount, note, photos, to_uid, created_by, created_at, legacy_id)`
- `fin_accounts(uid, name, cash, card, since)`；`fin_cfg(k, v)`

**财务接口**（前缀 `/api/fin/`）
`GET bootstrap` · `POST entries` · `PATCH|DELETE entries/:id` · `PUT entries/:id/photos` · `PUT accounts/:uid` · `PUT cats` · `PUT opening` · `POST photo` · `GET photo/<key>` · `POST import` · `POST remap`

**记账类型 kind**：`out` 支出 / `in` 收入 / `float` 备用金 / `move` 取现存现

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

**前端关键函数**：`finHtml`(渲染) · `finSheet(presetTo, presetKind, editEntry)`(记/改表单) · `openFinMenu`(⋯ 菜单) · `loadFin`(拉 bootstrap) · `finUpload`(照片) · `finAcct` / `finFloatOf`(算账)

**已完成（均验收过）**

1. 独立页 + 返回目录 + 标题「财务」
2. 资金账户：我 / 全部 / 某人；现金 + 银行；来源 − 花费 = 剩余
3. 记一笔：支出 / 收入 / 取现 / 备用金；分类 · 归属 · 渠道 · 照片≤6
4. 备用金「给员工」：从谁出=本人、发给谁=所选；员工往来卡「收到 − 已花 = 剩余」
5. 行内「⋯」编辑 / 删除；管理者改全部、员工改自己
6. 照片：记一笔/编辑都能补——「拍照」「从相册选」双入口、缩略图可 × 移除、n/6、失败有提示、可点看大图

**待办**：迁移旧「ECOOBOX 公司管理」的财务数据；下线旧应用。

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
3. `python ops/build.py` + `node --check ops/dist/worker.js`。
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
