-- ecobox 日常经营管理 · 最小库结构（D1 / SQLite）
-- 只做一件事：多人各自账号 + 全公司共享的经营数据（日报 / 人员）

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  login       TEXT NOT NULL UNIQUE,            -- 账号：邮箱 / 手机号 / 姓名，登录用
  name        TEXT NOT NULL,
  phone       TEXT DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'staff',   -- admin | manager | finance | staff
  lang        TEXT NOT NULL DEFAULT 'zh',      -- zh | en（界面语言，跟着账号走）
  shortcuts   TEXT NOT NULL DEFAULT '',        -- 快捷（置顶）模块键，JSON 数组，顺序即显示顺序
  site        TEXT DEFAULT '',                 -- 历史字段：人员不再挂矿区，保留兼容
  pwd_hash    TEXT NOT NULL,
  pwd_salt    TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  deleted     INTEGER NOT NULL DEFAULT 0,      -- 删除=软删（数据仍关联 id），并腾出账号名
  created_at  TEXT NOT NULL,
  last_login  TEXT DEFAULT '',
  modules     TEXT NOT NULL DEFAULT ''        -- 可用模块，逗号分隔；空 = 默认全部（除管理员专属）
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  ua          TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,                   -- YYYY-MM-DD
  site        TEXT NOT NULL DEFAULT '',        -- 矿区 / 项目
  shift       TEXT NOT NULL DEFAULT '白班',     -- 白班 | 夜班 | 全天
  crew        TEXT NOT NULL DEFAULT '',        -- 班组
  headcount   INTEGER NOT NULL DEFAULT 0,      -- 出勤人数
  ore_t       REAL NOT NULL DEFAULT 0,         -- 矿石 吨
  waste_t     REAL NOT NULL DEFAULT 0,         -- 废石 吨
  product     TEXT NOT NULL DEFAULT '',        -- 产品（钽铌精矿 / 手工原矿 …）
  qty         REAL NOT NULL DEFAULT 0,         -- 产量数量（配合 unit）
  unit        TEXT NOT NULL DEFAULT 'kg',      -- kg | t | bag | truck
  ta          REAL NOT NULL DEFAULT 0,         -- 钽品位 %
  nb          REAL NOT NULL DEFAULT 0,         -- 铌品位 %
  photos      TEXT NOT NULL DEFAULT '',        -- JSON 数组：R2 照片 key（≤6）
  grade       TEXT NOT NULL DEFAULT '',        -- 品位描述（Ta2O5 等）
  cost_usd    REAL NOT NULL DEFAULT 0,         -- 当日支出 USD
  note        TEXT NOT NULL DEFAULT '',
  user_id     INTEGER NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_logs_day ON logs(day);
CREATE INDEX IF NOT EXISTS ix_logs_site ON logs(site, day);
CREATE INDEX IF NOT EXISTS ix_logs_user ON logs(user_id);

CREATE TABLE IF NOT EXISTS audit (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  user_id     INTEGER,
  action      TEXT NOT NULL,
  target      TEXT DEFAULT '',
  detail      TEXT DEFAULT ''
);


-- 公司资料库（赞比亚实体：PACRA 登记、股东、董事）
CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_en       TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL DEFAULT 'company',  -- company | person
  reg_no        TEXT NOT NULL DEFAULT '',         -- PACRA 注册号
  reg_date      TEXT NOT NULL DEFAULT '',
  tpin          TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  phone         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  share_capital REAL NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'ZMW',
  shareholders  TEXT NOT NULL DEFAULT '[]',       -- [{name,nationality,id_no,amount,pct}]
  directors     TEXT NOT NULL DEFAULT '[]',       -- [{name,nationality,id_no,role}]
  notes         TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '',
  docs          TEXT NOT NULL DEFAULT '[]',       -- [{k,label,name,key,mime,size,at}] 文件在 R2
  created_at    TEXT NOT NULL DEFAULT '',
  updated_at    TEXT NOT NULL DEFAULT '',
  created_by    TEXT NOT NULL DEFAULT '',
  updated_by    TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS companies_name ON companies(name);

-- 打卡（考勤）：办公点 + 每日两段打卡
CREATE TABLE IF NOT EXISTS att_cfg (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  site_name   TEXT NOT NULL DEFAULT '',
  lat         REAL NOT NULL DEFAULT 0,
  lng         REAL NOT NULL DEFAULT 0,
  radius      INTEGER NOT NULL DEFAULT 300,      -- 允许打卡半径（米）
  start_t     TEXT NOT NULL DEFAULT '08:00',
  end_t       TEXT NOT NULL DEFAULT '17:00',
  grace       INTEGER NOT NULL DEFAULT 15,       -- 迟到宽限（分钟）
  updated_at  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS attendance (
  uid         TEXT NOT NULL,                     -- users.login
  d           TEXT NOT NULL,                     -- YYYY-MM-DD（本人本地日期，前端给）
  name        TEXT NOT NULL DEFAULT '',
  in_at       TEXT NOT NULL DEFAULT '', in_hm  TEXT NOT NULL DEFAULT '',
  out_at      TEXT NOT NULL DEFAULT '', out_hm TEXT NOT NULL DEFAULT '',
  in_lat      REAL NOT NULL DEFAULT 0, in_lng  REAL NOT NULL DEFAULT 0, in_dist  INTEGER NOT NULL DEFAULT 0,
  out_lat     REAL NOT NULL DEFAULT 0, out_lng REAL NOT NULL DEFAULT 0, out_dist INTEGER NOT NULL DEFAULT 0,
  acc         REAL NOT NULL DEFAULT 0,
  site        TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (uid, d)
);
CREATE INDEX IF NOT EXISTS attendance_d ON attendance(d);

-- 客户（买方档案）
CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  contact     TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  wechat      TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  addr        TEXT NOT NULL DEFAULT '',
  bank        TEXT NOT NULL DEFAULT '',
  swift       TEXT NOT NULL DEFAULT '',
  acc_no      TEXT NOT NULL DEFAULT '',
  currency    TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  by_name     TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS customers_name ON customers(name);

-- 出口单：7 段流程（applied/moses/analysis/valuation/royalty/permit/exported）
CREATE TABLE IF NOT EXISTS exports (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL DEFAULT '',
  co          TEXT NOT NULL DEFAULT '',
  mineral     TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'product',   -- product | sample
  qty         REAL NOT NULL DEFAULT 0,
  unit        TEXT NOT NULL DEFAULT 't',
  importer    TEXT NOT NULL DEFAULT '',
  dest        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'applied',
  permit      TEXT NOT NULL DEFAULT '',
  hs          TEXT NOT NULL DEFAULT '',
  elems       TEXT NOT NULL DEFAULT '',
  by_name     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  stages      TEXT NOT NULL DEFAULT '{}',        -- {stage:{at,by,...字段}}
  files       TEXT NOT NULL DEFAULT '[]',        -- [{k,stage,key,name,mime,size,at}] 文件在 R2
  created_at  TEXT NOT NULL DEFAULT '',
  updated_at  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS exports_date ON exports(date);
