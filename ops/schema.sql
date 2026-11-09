-- ecobox 日常经营管理 · 最小库结构（D1 / SQLite）
-- 只做一件事：多人各自账号 + 全公司共享的经营数据（日报 / 人员）

CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  login       TEXT NOT NULL UNIQUE,            -- 账号：邮箱 / 手机号 / 姓名，登录用
  name        TEXT NOT NULL,
  phone       TEXT DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'staff',   -- admin | manager | staff
  site        TEXT DEFAULT '',
  pwd_hash    TEXT NOT NULL,
  pwd_salt    TEXT NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
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
