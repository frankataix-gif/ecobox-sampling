"""把页面内联进 Worker，产出可直接上传的单文件 dist/worker.js。"""
import io
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.abspath(__file__))


def main():
    html = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    html = html.replace("__BUILD__", time.strftime("%Y-%m-%d %H:%M"))
    src = io.open(os.path.join(ROOT, "worker.js"), encoding="utf-8").read()
    lic = ""
    licp = os.path.join(ROOT, "licence.html")
    if os.path.exists(licp):
        lic = "globalThis.__LIC_PAGE__ = %s;\n" % json.dumps(
            io.open(licp, encoding="utf-8").read(), ensure_ascii=False)
    out = "globalThis.__OPS_PAGE__ = %s;\n%s%s" % (json.dumps(html, ensure_ascii=False), lic, src)
    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    p = os.path.join(dist, "worker.js")
    io.open(p, "w", encoding="utf-8", newline="\n").write(out)
    print("dist/worker.js  %d KB（页面 %d KB）" % (len(out.encode("utf-8")) // 1024, len(html.encode("utf-8")) // 1024))


if __name__ == "__main__":
    main()
