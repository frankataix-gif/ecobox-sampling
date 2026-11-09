"""一键部署 ecobox 经营管理：建 D1 → 建表 → 传 Worker → 设初始化口令。
用法：python ops/deploy.py           （读环境变量 CLOUDFLARE_OPS_TOKEN）
     python ops/deploy.py --status  只查看现状，不做改动
"""
import io
import json
import os
import secrets
import sys
import urllib.error
import urllib.request
import uuid

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))
API = "https://api.cloudflare.com/client/v4"
WORKER = "ecobox-ops"
DBNAME = "ecobox-ops"
TOKEN = os.environ.get("CLOUDFLARE_OPS_TOKEN") or os.environ.get("CLOUDFLARE_API_TOKEN") or ""
ACCOUNT = os.environ.get("CF_ACCOUNT_ID", "")


def call(method, path, body=None, raw=None, ctype=None):
    url = API + path
    data = None
    headers = {"Authorization": "Bearer " + TOKEN}
    if raw is not None:
        data = raw
        headers["content-type"] = ctype
    elif body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        txt = e.read().decode("utf-8", "replace")
        raise SystemExit("HTTP %s %s %s\n%s" % (e.code, method, path, txt[:600]))


def account_id():
    global ACCOUNT
    if ACCOUNT:
        return ACCOUNT
    r = call("GET", "/accounts")
    accs = r.get("result") or []
    if not accs:
        raise SystemExit("这个 token 看不到任何账号")
    ACCOUNT = accs[0]["id"]
    print("账号：%s (%s)" % (accs[0]["name"], ACCOUNT))
    return ACCOUNT


def find_db(acc):
    r = call("GET", "/accounts/%s/d1/database" % acc)
    for d in r.get("result") or []:
        if d.get("name") == DBNAME:
            return d["uuid"]
    return None


def create_db(acc):
    r = call("POST", "/accounts/%s/d1/database" % acc, {"name": DBNAME})
    return r["result"]["uuid"]


def apply_schema(acc, db):
    sql = io.open(os.path.join(ROOT, "schema.sql"), encoding="utf-8").read()
    stmts, buf = [], []
    for line in sql.splitlines():
        if line.strip().startswith("--"):
            continue
        buf.append(line)
        if line.rstrip().endswith(";"):
            s = "\n".join(buf).strip()
            if s:
                stmts.append(s)
            buf = []
    if "".join(buf).strip():
        stmts.append("".join(buf).strip())
    for s in stmts:
        call("POST", "/accounts/%s/d1/database/%s/query" % (acc, db), {"sql": s})
    print("建表：%d 条语句" % len(stmts))


def multipart(fields, files):
    boundary = "----ops" + uuid.uuid4().hex
    out = io.BytesIO()
    for k, v in fields:
        out.write(("--%s\r\nContent-Disposition: form-data; name=\"%s\"\r\n\r\n" % (boundary, k)).encode())
        out.write(v.encode() + b"\r\n")
    for k, filename, content in files:
        out.write(("--%s\r\nContent-Disposition: form-data; name=\"%s\"; filename=\"%s\"\r\n"
                   "Content-Type: application/javascript+module\r\n\r\n" % (boundary, k, filename)).encode())
        out.write(content.encode() + b"\r\n")
    out.write(("--%s--\r\n" % boundary).encode())
    return out.getvalue(), "multipart/form-data; boundary=" + boundary


def deploy_worker(acc, db):
    src = io.open(os.path.join(ROOT, "dist", "worker.js"), encoding="utf-8").read()
    meta = {
        "main_module": "worker.js",
        "compatibility_date": "2026-01-01",
        "bindings": [
            {"type": "d1", "name": "DB", "id": db},
            {"type": "r2_bucket", "name": "PHOTOS", "bucket_name": "ecobox-finance"},
        ],
        "observability": {"enabled": True},
    }
    body, ctype = multipart([("metadata", json.dumps(meta))], [("worker.js", "worker.js", src)])
    call("PUT", "/accounts/%s/workers/scripts/%s" % (acc, WORKER), raw=body, ctype=ctype)
    print("Worker 已上传：%s" % WORKER)


def set_secret(acc, name, value):
    r = call("PUT", "/accounts/%s/workers/scripts/%s/secrets" % (acc, WORKER),
             {"name": name, "text": value, "type": "secret_text"})
    if not r.get("success", True):
        raise SystemExit("设置密钥失败：%s" % r)


def subdomain(acc):
    r = call("GET", "/accounts/%s/workers/subdomain" % acc)
    sub = (r.get("result") or {}).get("subdomain")
    if not sub:
        sub = "ecobox" + secrets.token_hex(3)
        call("PUT", "/accounts/%s/workers/subdomain" % acc, {"subdomain": sub})
    return sub


def q(acc, db, sql):
    r = call("POST", "/accounts/%s/d1/database/%s/query" % (acc, db), {"sql": sql})
    res = r.get("result") or []
    return (res[0].get("results") if res else []) or []


def migrate(acc, db):
    """老库把 users.email 改成 users.login（账号可以是邮箱/手机号/姓名）。"""
    cols = [c.get("name") for c in q(acc, db, "PRAGMA table_info(users)")]
    if "email" in cols and "login" not in cols:
        q(acc, db, "ALTER TABLE users RENAME COLUMN email TO login")
        print("迁移：users.email → users.login")
    if "modules" not in cols:
        q(acc, db, "ALTER TABLE users ADD COLUMN modules TEXT NOT NULL DEFAULT ''")
        print("迁移：users 增加 modules 列")


def d1_id_from_worker(acc):
    """token 没 D1 列表权限时，从现有 Worker 的绑定里读出 D1 id（只更新代码时用）。"""
    r = call("GET", "/accounts/%s/workers/scripts/%s/settings" % (acc, WORKER))
    for b in (r.get("result") or {}).get("bindings") or []:
        if b.get("type") == "d1" and b.get("name") == "DB":
            return b.get("database_id") or b.get("id")
    return ""


def enable_route(acc):
    """新建的 Worker 默认不挂 workers.dev 路由，必须显式打开（PUT 会被 405 拒，要用 POST）。"""
    call("POST", "/accounts/%s/workers/scripts/%s/subdomain" % (acc, WORKER), {"enabled": True})
    print("workers.dev 路由：已开")


def main():
    if not TOKEN:
        raise SystemExit("缺 CLOUDFLARE_OPS_TOKEN 环境变量")
    acc = account_id()
    if "--code-only" in sys.argv:
        db = os.environ.get("CF_D1_ID") or d1_id_from_worker(acc)
        if not db:
            raise SystemExit("读不到 D1 id，用 CF_D1_ID 环境变量指定")
        deploy_worker(acc, db)
        set_secret(acc, "SETUP_TOKEN", os.environ.get("OPS_SETUP_TOKEN") or secrets.token_urlsafe(12))
        enable_route(acc)
        print("只更新了 Worker 代码（D1 结构与数据未动）：%s" % db)
        return
    db = find_db(acc)
    if "--status" in sys.argv:
        print("D1：%s" % (db or "未创建"))
        return
    if not db:
        db = create_db(acc)
        print("已建 D1：%s (%s)" % (DBNAME, db))
    apply_schema(acc, db)
    migrate(acc, db)
    deploy_worker(acc, db)
    enable_route(acc)
    setup = os.environ.get("OPS_SETUP_TOKEN") or secrets.token_urlsafe(12)
    set_secret(acc, "SETUP_TOKEN", setup)
    sub = subdomain(acc)
    url = "https://%s.%s.workers.dev" % (WORKER, sub)
    print("\n" + "=" * 58)
    print("地址：%s" % url)
    print("初始化口令（只显示这一次）：%s" % setup)
    print("第一次打开页面：点『还没有账号？找管理员开通』上方——在页面里用口令建管理员")
    print("=" * 58)


if __name__ == "__main__":
    main()
    os._exit(0)  # Windows 上 urllib 连接不释放会让进程挂住，直接退
