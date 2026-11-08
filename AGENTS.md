# 仓库须知（给后续 agent）

单文件离线 PWA，无构建步骤。改完直接刷新页面即可，发布走 GitHub Pages。

## 结构

- `sampling_helper.html`：取样工具，全部前端（样式 + 一个内联 `<script>`）。改完必须跑 `node --check`。
- `licences.html`：**赞比亚矿权介绍**（单页应用，只有矿证这一个主题）。侧栏是项目列表（`order` 排序；`name` 为显示名，`no` 为证号），右侧是选中项目的五个分类：项目介绍 / 项目地图 / 项目地质报告 / 现场取样结果 / 工厂信息。
  侧栏顶部只有「⚙ 设置」（密码 `123`，`sessionStorage.lic_setok`，本次会话有效）。设置**只有一个入口**：先是项目列表，点某一行的「设置」就进**那个项目自己的**设置页（`#set/<证号>`），里面是这个项目的全部内容：
  · 矿证信息：字段表（改值、删字段、加字段），覆盖存 `localStorage.lic_info_v1`；未覆盖时用 `licences.json` 的 `info` 数组，再退化到由 holder/type/status/commodities 拼的默认字段。项目页「项目介绍」里展示的就是这张表。
    上方有粘贴框：把矿证网站上的文字整段粘进来，「解析并填充」按 `INFO_ALIAS` 把「许可证号 / 持有人 / 地址 / 面积 …」对到标准字段（先精确、再包含匹配，`*` 会洗掉），认出的字段高亮，认不出的行在提示里点名；改完点保存。
  · 矿证资料：上传扫描件/批文/PDF，原件存 IndexedDB `lic_files_db`（store `files`，索引 `no`）；文字记录存 `localStorage.lic_notes_v1`（输入即自动保存，可「存为 txt 资料」）。只在本机，不进仓库也不上云。
  项目页顶部只保留一行：`项目名 + 状态徽标 + 证号 · 矿区 · 公司持有`，二级菜单 `项目介绍 / 项目地图 / 项目地质报告 / 项目信息` 也在顶部栏（`#tabs` 在 `.top` 里，正文不再重复标题）。
  矿证信息固定 9 个默认字段（`INFO_LABELS`）：`公司持有 / 许可证类型 / 许可证状态 / 批准时间 / 到期时间 / 地区 / 产区面积 / 矿产 / 开发目标`；`normInfo()` 把旧的「持有人」归一成「公司持有」、丢掉已废弃字段、补空默认值，用户自己加的字段排在后面。
  英文取值只做显示翻译、不改数据：`zhStatus / zhType / zhMineral / zhRegion`（`zhVal()` 按字段名分派），列表状态列与标题徽标同样走 `zhStatus()`；公司名、证号保持原文。
  项目列表是**纯展示**：`项目名称 / 证号 / 持有人 / 状态 / 排序 / 设置`，没有任何输入框；点「设置」进该项目的设置页，名称、证号、矿区、排序和字段表、资料、留言都在那一页改，点页面底部「保存」一次性写入（`saveSettings()`）。
  「公司持有」「许可证状态」来自字段表，保存时 `syncProjectFromInfo()` 写回项目属性 `holder` / `status`（列表、项目页、导出 json 都用这两个字段，`SYNC_PAIRS` 同时认「持有人」旧名）。
  项目页（`#view`）里**没有外层卡片**：`.detail` 不设背景/边框，`.pane` 只是 `padding:14px 0 26px`，内容直接铺在页面底色上；顶部标题栏 + 二级菜单保持原样。
  矿权边界（KML）：设置页「＋ 上传 KML」或直接把文件拖到该卡片（`#kmlPanel` 的 drop 事件）读 `.kml`（`parseKml()` 按 `localName` 匹配，兼容 `<kml:Polygon>` 前缀；外环 `outerBoundaryIs` 与内环 `innerBoundaryIs` 分开，面积 = |外环| − |内环|；多块按所有顶点算 bbox），算出顶点数、外接框、中心、球面面积（`ringAreaKm2()`，km²）；结果连原始文本存 `localStorage.lic_kml_v1`（`{证号:{name,ts,rings,inner,bbox,center,area,pts,parts,kind,raw}}`）。`.kmz` 会明确提示「另存为 KML」，同名替换会先确认。项目地图优先用 KML 的 bbox 和中心自动缩放（`mapFitZoom()`；见下条），并保留 `kmlSvg()` 轮廓示意，支持「复制边界坐标」；设置页可「下载」「删除」。改证号时 `renameProject()` 一并迁移 KML 记录。
  设置页防丢：属性输入（名称/证号/矿区/排序）在重绘前用 `stashProps()` 存进 `DRAFT`，所以传 KML、加删字段都不会清掉没保存的输入；`isDirty()` 拿当前 DOM + `SROWS` 跟**已存下来的** `licByNo().info` 比，离开设置页（返回列表、点左侧项目）会 confirm 提醒。
  不重复原则：证号只有一个入口（设置页顶部「证号」），粘贴里的「许可证号」直接填那儿，不再生成「矿证号」字段；KML 只归「矿权边界」卡，资料列表过滤掉 `.kml/.kmz`；地图页两个复制按钮分别叫「复制中心坐标」「复制边界坐标」。面积以**矿业部出具的产区面积**为准，KML 算出来的只标「参考面积」互校，不自动写进字段。
  项目地图（`#gmap`）是自绘瓦片地图，不引 Leaflet/Google API：`mapMount()` 把中心 + 边界塞进 `MAP`，`mapDraw()` 按 Web 墨卡托算瓦片行列（256px，`left/top` 绝对定位铺满），SVG 层再画 `<path class="gpoly">`（多环用 `fill-rule=evenodd` 挖洞）、顶点 `circle.gv`、面积 `text.glabel`。`fit` zoom 用 `mapFitZoom()` 让 bbox 占 84% 视口。交互：指针拖动（改 center）、滚轮/双击/±（围绕光标缩放）、`⤢` 回边界、右上角切卫星/街道（存 `localStorage.map_layer_v1`）。瓦片源：卫星用 Esri `World_Imagery`（Maxar 影像，和 Google Earth 同源素材）；**不用 Google 瓦片**——那没有可嵌入的官方地址，只适合自己看看。没网时瓦片空着，边界/面积照画。
  坐标表也能直接进：设置页「＋ 粘贴坐标」把矿业部/ArcGIS 的坐标表（`13°08'48.00" S 30°04'18.00" E`、`13 08 48 S 30 04 18 E`、`-13.146667, 30.071667`）逐行读成环（`parseCoordText()`：去序号、去度分秒符号、纬度在前，缺 S 且落在 20–45°E / 0–35°N 时按南纬；明显的经,纬 顺序会自动调换），`kmlFromPts()` 去重、去闭合点、算 bbox/中心/面积后按「手工坐标（N 点）」存进同一个 `lic_kml_v1`，`raw` 就是粘贴的原文。
  改证号 = 改主键：`renameProject()` 迁移 `INFO` / `EDITS` / `ADDED` / `NOTES` / IndexedDB 里的文件 `no`；基础项目的 patch 仍按 json 原始证号存（`keyOf()` 靠 `patch.no` 找回），所以改名不会丢改动，也不会和 json 打架。
  删除基础项目记在 `DELETED`（和 `EDITS`/`ADDED` 一起存 `lic_edit_v1` 的 `deleted`），`applyEdits()` 过滤掉；「还原 json」会一并清空。
  「+ 新增项目」会建一个 `未命名-NN` 的临时项目并直接打开它的设置页，填好证号点保存即完成改名。
  动态与留言存 `localStorage.lic_feed_v1`（本机，不共享，P2 接 Worker 后才多人可见）。
  前面有登录闸门（`ecobox` / `123456`，FNV-1a 哈希 + localStorage 30 天）。**这只是挡误入**：静态站点上 JSON 仍可被直接下载，要真保护得放到带鉴权的 Worker 后面。
- `sampling_sw.js`：离线缓存。**改任何缓存内容都要同时 bump `CACHE` 版本**，否则老客户端拿不到新文件。
- `areas.json`：矿区范围（bbox），只用于把记录按坐标自动归到矿区。
- `licences.json`：矿证 + 地质背景 + 取样要点（未知字段写「待核实」，不要编）。
- `samples.json`：现场取样结果（全量）。生成链：`devtools/export_samples.py`（python-qgis.bat）从 QGIS `field_samples.gpkg` 导 7 点 → `devtools/import_ecobox_samples.py`（普通 python）从 `samples_meta.json`（Ecobox D1 全量 36 条）导入并与 QGIS 7 点按坐标就近合并（<200m），按 bbox 自动归类 `area_id`（合并 areas.json + areas.local.json），照片按 `photos/<sid>/<NN>.jpg` 重建 R2 URL；字段 sample_id/area_id/lat/lon/symbol/mineral/sample_type/description/ta2o5_pct/nb2o5_pct/li2o_pct/cs_ppm/be_ppm/sn_ppm/assays[]/photos[]/source/datetime/status/recorder/license_no。发布时 `build_public.py` 只保留 `area_id==serenje_1330nw` 的 24 条。
- `factory.json`：工厂信息（框架已建；location/equipment/capacity/plan，逐步补充）。
- `geo_packs/`：离线地图包，`index.json` 列出可用包 id。

## 数据层

- IndexedDB 库名 `field_sampling`。store：`samples`（唯一记录库，含照片 Blob）、`kv`、`tiles`、`track`、`trips`。
- **不要**再按矿区拆 store：取样是独立动作，矿区只是记录上的 `area_id` 字段，由 `areaAt(lat,lon)` 自动判定。
- 样品读写统一走 `S.*`；kv 用 `store.get/set`。
- 试验版遗留的 `samples_*` 由 `mergeLegacyStores()` 首启并回主库（标记 `kv.areas_merged_v2`）。

### 写入路径的坑（2026-11-07 修）

- `S.put()` **必须回写自增主键**。不带 `id` 的 `put()` 在 IndexedDB 里是**插入新行**；
  旧版没写回，于是「保存 → `autoSync` 又 `S.put` 一次」会给每条新记录插出两条同号记录。
  现在 `S.put` 完成后把 `r.result` 赋回 `s.id`。改这里之前先想清楚所有调用点（保存、编辑、同步、迁移）。
- 一次性修复：`dedupeSamples()`（标记 `kv.dedupe_v1`）按 `sample_id` 去重，保留后写的那条，
  并把「已同步」状态和照片并过去；启动时在 `mergeLegacyStores()` 之后调用。
- `uploadSample()` 的 `captured_licence` 只能取 `s.captured_licence`。
  早期写成 `s.licence||s.license_no`（S1 已删的字段），结果把采集快照清成空串再写进 D1。
- 上传载荷里 `status` 固定为 `"synced"`：客户端的同步状态不该写进云端记录。
- 照片上传成功后把 `key/url/idx` 回写本地记录；重试/再保存时同序号照片直接复用，不再重传几 MB。
- 地图位图缓存 `tileCache` 上限 240 张（LRU），瓦片本体仍在 IndexedDB `tiles` 里。

## 验证方式

本地起 `python -m http.server`，用一个同源测试页 iframe 载入 `sampling_helper.html`，父页可直接读 `contentDocument` 和 IndexedDB 做断言（曾经的 P1 测试即此法）。注意：`indexedDB.deleteDatabase` 会被未关闭的连接阻塞，测试里要给超时兜底。

## 版本号

改完在 `ecobox-sampling/` 下跑 `py -3.12 devtools/bump_version.py`，一次同步三处（`--dry-run` 可先看）：
`sampling_helper.html` 的 `APP_VER` + 设置页两处显示、`sampling_sw.js` 的 `CACHE`（`sampling-vNN` 必须变，否则老客户端不换缓存）、`version.txt`。

`version.txt` 是**更新探针**：页面加载后、回到前台、每 5 分钟各 fetch 一次（`no-store`），内容与 `APP_VER` 不一致就在底部导航上方弹出「🔄 有新版本 / 立即更新 / 稍后」。
「立即更新」优先走 `SW.postMessage("SKIP_WAITING")` + `controllerchange` 重载，没有 waiting SW 时退回 `forceAppUpdate()`（清缓存 + 注销 SW + 带 `?r=` 重载）。
`version.txt` 必须发布（不能进 `.gitignore`）；漏传时探针 404，横幅永远不弹。

## 地质图层（QGIS → 网页，2026-11）

- 导出脚本：`devtools/export_qgis.py`，用 `"C:\Program Files\QGIS 4.2.2\bin\python-qgis.bat"` 跑，**只读** gpkg，不碰 `.qgz`。
- 产物：`ecobox-sampling/geo/serenje-1330nw/`（`index.json` + 每层 `<key>.geojson` + `mag.jpg`）。
  lite ≈ 47 KB（边界/断层/靶区/矿脉/矿化点/取样点），full ≈ 1.9 MB（岩性/地质界线/构造/环状构造/接触带/磁异常）。
- 前端：`licences.html` 里 `GEO_SLUGS`（按 `area_id` 或 `no` 前缀）→ `geoInit()/geoEnsure()/geoMarkup()`；
  lite 进地图即加载，full 点「全部加载」才拉；开关状态存 `localStorage.geo_layers_v1`。
- SW 对 `geo/` 走「缓存优先 + 后台更新」，所以看过一次就离线可用。
- **坑 1**：gpkg 里多数图层本身就是 `EPSG:4326`，**不要**一律按 32736 硬转（转两次坐标成 -57/-85 乱码）。用 `layer_transform()` 读图层自身 SRS。
- **坑 2**：`OGRGeometry.GetEnvelope()` 返回 `(minX, maxX, minY, maxY)`，不是 `(minX,minY,maxX,maxY)`。
- **坑 3**：QML 的分级渲染里 `<categories>` 在 `<symbols>` **之前**，抽配色时 categories 要在全文找、symbols 只在 `<symbols>` 块里找。
- **坑 4**：`gdal.Warp` 没有 `scaleParams`；先 `gdal.Translate(scaleParams=...)` 转 8bit，再 Warp 到 4326。磁异常出 JPEG（PNG 会 2.8 MB）。
- 重新导出后：确认坐标落在 30.07~30.25 / -13.15~-13.10，再跑 `devtools/t_geo.html`（21 条断言）。
- 项目 vs 矿权：`areas.json` 的 `areas[].licences[]` 就是「一个项目挂多个矿证」；地质资料挂在 **area** 上只有一份，矿证仍各自独立（面积/有效期/持有人不合并）。

## 发布到 GitHub Pages（2026-11 起）

- 线上：`https://frankataix-gif.github.io/ecobox-sampling/licences.html`；仓库根 = 站点根。
- **只发布公开子集**：`python devtools\build_public.py` → 生成 `_deploy/public/`（只留 42881 / serenje_1330nw，`licences.json` 里其它矿证不上传）。
- 推送：`_deploy/public/*` 覆盖到仓库克隆（如 `C:\Users\25534\workspace\_repo\ecobox-sampling`）→ commit → `git push origin HEAD:main`。
  本机已存在 GitHub 凭据（GitHub Desktop 装的 credential manager），**`git push` 不会要 token**。
- Pages 推送后 30–60 秒生效；验证 `licences.html` 200 且大小 ≈92 KB。
- 线上更新后老客户端可能仍吃旧 SW：刷新两次，或 DevTools → Application → Service Workers → Unregister。

## 数据模型不变式（用户反复强调，不许再动摇）

1. **取样记录只对「坐标 + 地质事实」负责**：坐标、时间、观察、样品类型、化验、照片。
   **矿证不在取样记录里出现**，不是字段、不是外键、不是必填项。取样点可以落在任何矿证之外。
2. **矿证 = 分析视角（一个多边形筛选器）**，不是归属。「某点属于某证」是**读的时候算出来的**（点在多边形内），
   不是写的时候填进去的。矿证换发/拆分/改界，取样数据一个字都不用改。
3. 采集时按坐标猜出的证号只能作为 **采集快照**（`captured_*`，审计用），**不参与统计、不对外展示、不进导出**。
4. 项目/矿权分析端才做「范围内 vs 范围外」对比（点位数、元素均值、距离分布），用来判断矿权价值与扩界证据。
5. `area_id` 的语义是**工作区 / 图幅 / 项目**（离线命名空间、GPS 自动归档用），**不是矿证**。
   一个 area 可挂多个矿证；矿证也可以横跨两个 area。
6. QGIS 侧已符合：`field_samples` 字段为 Sample_ID/Symbol/Mineral/Description/Photo/Source/Ta2O5_pct/Nb2O5_pct/Sample_date，
   **没有**矿证字段 —— 同步脚本也不许加。

## 矿权分析框架（不变式之二）

**看整体，答局部。** 分析矿权不能只盯证内数据，必须从宏观大地构造往下收敛；但所有结论必须落回
「证内有没有东西 / 值不值得勘探 / 下一步怎么找」。

尺度阶梯（每一层都要有数据支撑，缺哪层标缺）：

- **L0 大陆·克拉通（1:10M）**：Congo Craton / Bangweulu Block / Irumide Belt / Mozambique Belt /
  Lufilian Arc / Mwembeshi 剪切带 —— 回答「这片大地构造位置对不对」。
- **L1 区域成矿带（1:1M）**：Irumide 期变形 + Kibaran 花岗岩 + LCT 伟晶岩带（Ta-Nb-Sn-Li-Cs）。
- **L2 图幅/矿区（1:100k）**：岩性、地质界线、构造、环形构造、接触带、磁异常（已有 geo 包）。
- **L3 矿权范围 + 1–5 km 缓冲**：边界、靶区、矿脉、已知矿化点（证内外对比）。
- **L4 点**：取样点 + 化验 + AI 照片解读。

结论载体是 **靶区台账（Target Ledger）**，不是散文：
`target_id, 名称, 层级来源, 依据[], 面积, 优先级, 状态(candidate/sampled/confirmed/refuted/drillable), 证据[sample_id…], 下次行动, 更新时间`。

数据回写规则：取样点落靶区内 → 追加证据 → 靶区状态机迁移。**AI 只汇总证据与置信度，不给"值得勘探"结论**，
go/no-go 由人拍板并记 decision log。取样点永不写入矿证归属（见第一条不变式）。

## 云基础设施（现状）

| 名称 | 值 | 说明 |
|---|---|---|
| 采样 API Worker | `https://fancy-heart-7a80.frankataix.workers.dev` | `/ping` `/sample` `/samples` `/ocr`，D1 `78e80331-66f2-486d-8d7a-d7cf906bc7a7`（表 `samples(sample_id,data,created_at,updated_at)`，整条 JSON） |
| 媒体 Worker | `https://ecobox-media.frankataix.workers.dev` | `POST /put?key=photos/<sid>/NN.jpg`（需 `X-Upload-Token`）、`GET /m/<key>`、`GET /health`、`POST /ai/desc`、`POST /ai/photo`；源码 `_deploy/worker/media-worker.js` |
| R2 桶 | `ecobox-media` | 照片/报告/图层；当前前缀白名单 `photos/ reports/ geo/ test/`，单文件 ≤16 MB |
| 上传口令 | `_deploy/worker/.media_token` | **不入库**；前端 `DEF_MEDIA_TOKEN` 内嵌（临时，见下） |
| 部署 | `$env:CLOUDFLARE_API_TOKEN=...; python devtools\deploy_media_worker.py` | 走 CF API multipart 上传，含 r2_binding + secret |

## AI（Gemini，2026-11 加）

- **端点**都在 ecobox-media Worker，需 `X-Upload-Token`；Gemini key 只存 `env.GEMINI_KEY`，前端拿不到：
  - `POST /ai/desc` `{text, sample?}` → `{description, category, subtype, assays[], notes}`
    把长描述规范化、把 `ta 0.05` / `钽0.05%` 统一成 `Ta=0.05%`，顺带定一级/二级分类。
  - `POST /ai/photo` `{key, force?}` → `{lithology, minerals[], texture, pegmatite_confidence, description, quality}`
    解读 R2 里的照片，结果缓存在 `ai/photo/<key>.json`，重复点击不重复计费。
- **模型**：文本 `gemini-3.5-flash-lite`、照片 `gemini-3.8-flash`（都有免费额度）。
  模型 ID 会下线（`gemini-2.5-flash` 已废弃并转到 3.5 Flash-Lite），worker 按 `TEXT_MODELS` / `VISION_MODELS`
  顺序自动降级，也可用 `MODEL_TEXT` / `MODEL_VISION` 环境变量钉死。
  实测（2026-11-02 真 key）：两个 ID 都在 `models` 列表内；文本 3~5 s，1024 px / 200 KB 照片约 35 s。
  热门模型会偶发 503 / 404 / 70 s 超时；`gemini()` 对 404 和任何 5xx（含超时，统一记 504）都换下一个模型，其余错误直接报回去。
- **前端**：编辑框 `✨ AI 整理描述`（结果可「撤销」）、每张照片右上角 `AI` 按钮、`AI 解读全部`；
  结果存 `localStorage.samp_photo_ai_v1`（键是照片 URL），卡片多一条 `AI：岩性 · 86%`，导出时并入 `photo_ai`。
- **照片说明**：解读完每张照片下方 `figcaption` 分三段——`岩性 · 置信 86%`（`<b>`）、`结构；矿物`（`.aimeta`）、
  模型描述（`.aidesc`，**全文显示，不做行数截断/省略号**），画质不佳再挂 `⚠ 偏暗`（`.aiq`）。由 `aiCapHTML(url)` 生成，
  `photoFig()` 初渲染和 `paintCap()` 复绘共用；没结果时返回空串，靠 `figcaption:empty{display:none}` 隐藏。
  版式是**一行一张**：`.sphotos` 纵向 flex，`figure.ph` 横向 flex（照片 124 px 定宽，手机上 96 px），
  说明占剩余宽度并在右侧留 46 px 给 `AI`/`✎` 按钮。**别改回田字格**——96 px 宽时说明会被挤成一行截断。
- **手工改说明**：解读完照片右上出现 `✎`（`data-photo-edit`），点开 `.pai-edit` 可改**岩性 / 矿物 / 描述**，
  保存写回 `samp_photo_ai_v1[url]` 并置 `edited:true`，`paintCap()` 重绘、`✎` 变绿；取消不改动。
  再跑一次 AI 会用新结果整体覆盖（`edited` 清掉），照片数据本体（`photos`/R2）不受影响。
- **忘记录入时补录**：取样页 `📷 从照片新建（自动定位）` → 选相册原图 → `exifFromBuffer()` 读 JPEG 的 APP1
  （HEIC 走 `Exif\0\0` 扫描）拿 GPS IFD + `DateTimeOriginal` → `createSampFromExif()` 建点：样号
  `M<拍摄日期>-序号`、状态 `待补录`、`source:"photo-exif"`，存 `localStorage.samp_new_v1`，再自动开编辑框补描述。
  有媒体令牌就顺手把这几张照片传上去。微信/QQ 转发、截图、压缩过的图没有 GPS，会明确报错而不是瞎猜坐标。
  **列表/地图/导出统一走 `sampAll()`**（= 本机新建 + `samples.json`），别再直接读 `SAMPLES`。
- **部署（2026-11-08 实际走通的那条）**：
  ```powershell
  cd _deploy\worker
  npx wrangler login          # 浏览器点 Allow，凭据存 %USERPROFILE%\.wrangler
  npx wrangler deploy         # 会把 script-API 传的旧代码覆盖掉，secret 保留
  (Get-Content .media_token -Raw).Trim() | npx wrangler secret put UPLOAD_TOKEN
  (Get-Content .gemini_key  -Raw).Trim() | npx wrangler secret put GEMINI_KEY
  ```
  另有 API token 路径：`python devtools\deploy_media_worker.py`。冒烟脚本 `python devtools\smoke_worker.py`
  （打线上 `/health` `/ai/desc` `/ai/photo`，只读本地令牌，不打印）。
- **实测延迟**：文本 3~5 s；**1.3 MB 原图**在 3.8-flash 上会顶到 70 s 超时，自动退到 3.5-flash-lite 才出结果（约 75 s）；
  同一张图压到 200 KB 后 3.8-flash 约 35 s。**待办：上传前在浏览器里压到 ~1600 px**，否则每张照片要等一分多钟。
- **测试**：`node devtools\test_media_worker.mjs`（真跑 worker，只替换 R2 / Gemini 两个外部边界，31 断言）
  + `devtools\t_ai.html`（24 断言，只替换 `fetch`，页面解析/落盘/渲染全真跑）。

## 云端鉴权（2026-11-07 起）

- 采样 Worker 已配 `APP_TOKEN`：`/ping` `/sample` `/samples` `/sample/<id>` `/ocr` 全部要求 `X-App-Token`，没带就 401。
  改之前是**全开**的（`env.APP_TOKEN` 为空时整段鉴权被跳过），等于任何人可读、可覆盖、可删 D1 里的取样记录。
- 令牌只存本机：`_deploy/worker/.sampling_token`，**不入库、不进仓库**。泄露或丢失就在 CF 重新
  `PUT /accounts/<acc>/workers/scripts/fancy-heart-7a80/secrets` 覆盖成新值，再让设备重扫一次。
- 设备授权：打开 `sampling_helper.html?t=<令牌>` 一次即可，页面把令牌写进 IndexedDB `app_token` 并清掉地址栏的 `?t=`；
  `_deploy/bootstrap.html` 是本地二维码页（每台设备扫一次）。
- 没授权的设备照样能离线记录，只是同步标 `failed`、提示「需要访问令牌」；补上令牌后点顶部「同步」补传，数据不丢。
- 媒体 Worker 的 `UPLOAD_TOKEN` 是**另一个独立口令**（仍硬编码在前端，见 S5 待办）。两者故意不共用：
  前端是公开的，合并只会把一个泄露点放大成全部权限。

## S1（照片搬 R2 + 取样与矿证解绑）— 已上线

- D1 里 36 个样点、58 张 base64 照片已迁到 R2，`/samples` 载荷 **53.4 MB → 29 KB**（约 1840×）。
- 迁移脚本：`devtools/migrate_photos.py`（`--dry-run` / `--apply [--limit N]`），迁移前自动备份到 `_deploy/backup/samples_<ts>.json`。
- 采集页 `uploadSample()` 现在先 `POST /put` 传照片拿 `{key,url}`，`/sample` 只收 key；离线时照片仍以 Blob 存在 IndexedDB，联网同步才上传。
- 取样记录不再写 `licence/license_no/license_holder`，只留 `captured_licence`（采集时快照，仅"位置参考"）；详情页、列表、CSV 均不再输出矿证列。
- **已知临时风险**：媒体上传口令内嵌在前端（公开仓库可见），只能写 `photos/ reports/ geo/ test/` 且 ≤16 MB。后续（S5）改为经采样 Worker 服务端代理，前端不再携带口令。

## 多矿权（多证）处理

数据分两层，文件名即边界：

| 文件 | 内容 | 是否发布 |
|---|---|---|
| `licences.json` / `areas.json` | 公开矿证与工作区（当前只有 42881 / serenje） | 是（GitHub Pages） |
| `licences.local.json` / `areas.local.json` | 仅本地矿证与工作区（43004 / kalomo） | 否，已进 `.gitignore` |

- 前端 `loadData()` 同时请求四个文件，后两个用 `jgetOpt` 容错：线上 404 自动跳过，本地有则合并。
- 合并规则 `mergeBy(pub, loc, key)`：**本地优先，公开兜底**；同 `no`/`id` 以本地为准。
- `devtools/build_public.py` 有守卫：`licences.json` 里出现非公开矿证直接 `SystemExit`，不再静默过滤。
- 新增一个矿证：① 在 `licences.local.json` 加条目（`no/area_id/center/info/geology`）→ ② 在 `areas.local.json` 加工作区（`id/bbox/center`）→ ③ 有地质数据就放 `geo/<slug>/` 并在 `GEO_SLUGS` 注册 `area_id -> slug`。不改页面代码。
- 43004 现状：只有 bbox 与中心点，**没有边界 KML、没有地质图层**，所以「项目地图」只定位到中心；可在页面「设置」里上传它的 KML 补边界。

## 取样与矿证解耦（采集页）

- 采样记录不再写 `licence/license_no/license_holder`，只保留 `captured_licence`（采集时所在地块快照，仅"位置参考"，非归属）。
- 详情页/列表/CSV 均已移除矿证列；需要"证内评价"时在分析端用点在多边形内做空间关联，而不是写进取样表。

## 前端结构：项目（area）为一等对象

- 侧栏 `#plist` 只列**项目**（一个 `area_id` 一行），显示 `项目名 / N 本矿证 / 综合状态`；矿证不再出现在侧栏，`plistHtml(activeArea)` + `projRows()`。
- 页面标题 `#ttl` 是项目名，`#sub` 列该项目的矿证号与持有人；状态 = `projStatus()`（任一矿证有效则「有效」）。
- 五个页签都按项目聚合，入参统一是 `ls = projLics(PROJ)`：
  - `tabIntro(ls)`：项目介绍 + 地质背景 + 取样要点；带「更新」按钮（`#introUpd`）→ `refreshIntro(btn,ls)`：`introFacts()` 汇总矿证/地质/取样/工厂关键事实，无 worker 走 `buildIntroTemplate()` 模板聚合，有 `localStorage.worker_url` 则 POST `/summarize`（`X-App-Token: s_token`）让 Worker 用服务端 AI key 精炼；结果存 `localStorage.lic_intro_override[area_id]`（覆盖显示，不改 licences.json）
  - `tabMap(ls)` / `mapMount(ls)` / `mapDraw()`：`projBBox()`/`projCenter()` 合并所有矿证 KML 的 bbox，一图画多条边界，`MAP.ks=[{no,k}]`
  - `tabReports(ls)`：报告列表，支持 `img`（PNG 图，`<a><img class="repimg">`）与 `legend`（图例）字段；42881 现有 5 条文字报告 + 8 条 QGIS 专题图报告（`report/serenje/map_01..08.png`，存 R2 桶 ecobox-media，经 `GET /m/<key>` 公开读）
  - `tabSamples(ls)`：读 `SAMPLES`，过滤 `area_id===PROJ`（`area_id` 为空的点单列「未归类·不在本项目范围」，不出现在地图上）；顶部「取样统计」卡 + **二级分类**：一级 `category`（取样 / 标记点，`SAMP_CATEGORIES`）→ 二级 `subtype`（取样：岩石/土壤/刻槽/其他；标记点：桥/路口/道路/电线/土地/农户/其他标记），`sampCat()` 优先读数据里的 `category/subtype`，缺失时按 `sample_type` + 描述关键词回退（`markerSubCat()`），数据由 `devtools/samp_classify.py`（`classify_samples.py --force` 可重跑）补全；分段按钮 `[data-scat]`（全部/取样/标记点）同时过滤列表和地图（切项目自动重置）；每点 `sampleCard()`（照片缩略图/`nophoto` 占位、品位 `gradeFmt()`（空值返回 `-`）、`hasTaNb` 为假时整行不显示、`status==="待化验"` 时不显示状态胶囊、化验 assays、坐标、记录人、描述）。**「上传照片」按钮**（`data-upload` → `uploadPhotos(sid,btn)`）：选图 → `POST ${MEDIA_URL}/put?key=photos/<sid>/<NN>.<ext>`（`X-Upload-Token` 读 `localStorage.m_token`，首次缺则 prompt 输入）→ 成功 URL 存 `localStorage.samp_photos_v1[sid]` → 渲染时 `sampleAllPhotos()` 合并（≤6 张）。**取样点地图**：统计卡下方 `#smap`（复用 `.gmap` 瓦片地图）：`mapMountSmap(rows,ls)` 用 `smapBBox()` 取有坐标样点范围（无坐标则退回 `projBBox(ls)`），`smapDraw()` 画 Esri 瓦片 + 矿权边界（虚线背景）+ 取样点（圆点=取样、按 subtype 着色 `SUB_COLORS`；菱形=标记点），z≥14 显示样号；点标记 → 滚动/高亮对应取样卡（`data-card`），支持拖动/滚轮/±/⌖/⤢/卫星道路切换。**联动与编辑**：点卡片空白处 → `smapFocus(sid)` 地图居中放大 + 琥珀色高亮（`.liccard.focus`）；点地图标记 → 跳到卡片；照片点击 → `openLightbox()` 全屏大图（多图可翻页）；「编辑」按钮 → `editSampleDialog(sid)`（描述 / 经纬度 / 用当前定位修正 GPS / 一级分类下拉 + 二级分类**标签墙**（`.subtags`：`SUB_BY_CAT` 两组全部平铺成可点标签，取样=岩石/土壤/刻槽/其他，标记点=桥/路口/道路/电线/土地/农户/其他标记；点标签自动同步一级分类，非当前组的标签变灰）/ 记录人 / 照片上传与放大）。**Ta₂O₅、Nb₂O₅ 输入框已取消**：品位统一写在描述里，描述下方 `.insrow` 快捷插入统一代码 `Ta=` `Nb=` `Li=` `Cs=` `Be=` `Sn=` `%` `ppm`（插入到光标处），避免同一元素出现多种写法；改动写 `localStorage.samp_edit_v1[sample_id]`，渲染时 `sampData(s)` 合并覆盖（不改 `samples.json`），「导出 samples.json」→ `exportSamples()` 下载合并后全量数据。**删除**：卡片「删除」或编辑弹窗「删除这个点」→ `confirm` → `deleteSample(sid)` 记入 `localStorage.samp_deleted_v1`（同时清掉该点的编辑覆盖 `samp_edit_v1` 与本地照片列表 `samp_photos_v1`），`tabSamples`/地图/统计/`introFacts` 全部用 `isSampDeleted()` 过滤；**删除不提供撤销**（确认弹窗是唯一关卡，写明"不能撤销"），也不再显示"本机已删除 N 条"红条——真要从数据里消失，仍然是「导出 samples.json」并替换文件；`exportSamples()` 导出的 samples.json 不含已删除点（替换文件并提交后即永久移除；R2 照片因 media worker 无 DELETE 端点，只解除页面引用）。桌面端 `.sampwrap` 左列表 + 右 440px 粘性地图（`top:98px`），窄屏（<1000px）上下堆叠。`tabFactory(ls)`（读 `FACTORY`）；旧的 `tabFeed/wireFeed` 已不用（动态入口移除，数据 `lic_feed_v1` 仍保留）
- 路由：`#proj/<area_id>` 进项目；`#lic/<no>` 仍可用（自动定位到该证所属项目）。
- 新增/编辑/删除矿证仍在「设置」里（项目 → 矿证两层），改完侧栏只更新「N 本矿证」计数。
- 测试：`t_multilic.html`（侧栏只列项目、加证后计数变 2、两张边界卡、地图画两条环）。
## 采集页（sampling_helper.html）页面结构

- 底部导航 3 项：`pg-form`（记录）/ `pg-map`（地图）/ `pg-set`（设置）。独立的 `pg-list`（取样）与 `pg-track`（行程）都已删掉。
- `pg-form` 内三个视图，用 `#formtabs` 切换：`tab_cur`（取样，录入表单）、`tab_list`（取样历史，已保存列表）、`tab_trip`（行程，轨迹记录 + 历史行程）。
  切换函数 `setFormTab("cur"|"list"|"trip")`；进列表视图才 `renderList()`，进行程视图才 `updTrk()/renderTrips()`。
  老客户端 `kv.cur_page === "pg-list"` / `"pg-track"` 由启动逻辑映射到对应视图；`kv.form_tab` 记住上次停留的视图。
- 记录人由登录锁定：`openLogin()` / `submitLogin()`，账号 `ACCOUNTS` 写在 HTML 里（离线无后端，已知取舍）；
  `#f_recorder` 只读，值取登录身份，保存时 `recorder` 直接取该字段，软件内无「切换」入口。
- 取样视图有**草稿自动保存**：`kv.draft`（文字/含量）+ `kv.draft_photos`（照片 Blob），切页/切后台/刷新后自动恢复，保存或「清空本次输入」后清除；半天以上视为过期。编辑旧记录期间不写草稿（避免被当成新记录）。
- 取样历史：`#q_list` 本地搜索（编号/备注/地区/记录人/元素）+ `#chips_filter`（全部/待同步/已同步）+ `#list_stat` 计数；卡片整卡可点开详情，详情里有「复制坐标」「立即同步这条」。
- 行程：记录中在 `#triplive` 显示实时卡片（时长/里程/点数），`#formtabs` 的🧭上有红点；回放轨迹会在切到地图页时自动清除。
- 设置页：`#set_user` 显示当前记录人；`#set_stat` 显示本机数据（样品/待同步/照片/行程/里程/离线瓦片）。
- **云端恢复**：`pullSamples()` 用 `GET {worker}/samples`（`X-App-Token`）把 D1 里已有记录补回本机：本机没有的新增、本机已同步的覆盖、本机未同步的保留；入口在设置页「♻️ 从云端恢复记录」和空列表页的按钮。云端记录的照片只有 R2 `url`（无 blob），缩略图/详情用 url 兜底，`uploadPhoto()` 见到 `key+url` 直接复用不再重传。
- **备份导入**：设置页 `#btn_import` → `#file_import` 读取「完整备份 JSON」（`{app,samples,trips}` 或裸数组），照片 `data`(base64) 用 `unb64()` 还原成 Blob；合并规则同云端恢复（新增 / 覆盖已同步 / 保留未同步）。导出时照片同时写 `data` 与 `key/url`，保证「导出→导入」可完整往返。
- 坐标区 `.gpsrow` 三个按钮（获取定位 / 地图选点 / 定位查看）一行三等宽 36px；改动后要在 320/360/414px 复测不换行。

## geo_packs 离线地质包（Chitambo 1230SE，2026-11）

- 生成：`build_geo_pack_chitambo.py`（QGIS Python，只读 `C:\QGIS_Local_Work\Chitambo_1230SE\1230SE_data.gpkg`），先写本地 `geo_packs/chitambo.json`，再复制到仓库同名路径。
- 结构：`{id,name,geo{litho[{s,r,b}],bounds[{t,p,b}],abc[],faults[],veins[],occs[{p,s}]},zones[{no,zone,name,ring,bb}],rights[{no,ring,b}],roads[{t}],geoimg[]}`；坐标一律 `[lat,lon]`，环只存外环且不闭合。
- 规模：229 岩性环 / 581 界线 / 7 靶区 / 7 矿权 / 635 道路 / 9 矿点，约 373 KB。`rings_of()` 取 2D 外环并简化，否则原始几何 >10 MB。
- **缺字段会崩**：早期包没有 `geo.abc`，`selectRegion()` 直接赋值会报 `GEO.abc is not iterable`。现在页面用 `{litho:[],bounds:[],abc:[],faults:[],veins:[],occs:[],...p.geo}` 归一化，包里也应显式写空数组。
- 校验：`validate_pack_against_sheet.py` 把每个顶点投到 `1230SE_Chitambo_georef.tif` 取灰度；界线和岩性环约 91% 落在印刷线条上（中位灰度 38）即对齐正常。`render_pack_preview.py` 输出叠加预览 PNG。
- 前端：`AREAS` 的 `chitambo_1230se`（bbox `30.4,-13.05,31.25,-12.35`，`map_pack:"chitambo"`）；`LITHO_COLOR` 必须含 `G2/G3/G4`；`geo.bounds` 与 `rights` 仅在选中该图幅时绘制。
