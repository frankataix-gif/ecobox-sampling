"""Bump the app version in one shot.

Keeps the three places that must agree in sync:
  sampling_helper.html  APP_VER + 设置页显示的版本号
  sampling_sw.js        CACHE = "sampling-vNN"  (每次必须变，否则 SW 不更新)
  version.txt           前端用来探测「有没有新版本」的探针文件

用法:
  py -3.12 devtools/bump_version.py              # 自动 +1
  py -3.12 devtools/bump_version.py b20261107-109
  py -3.12 devtools/bump_version.py --dry-run
"""
import datetime as dt
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
HTML = ROOT / "sampling_helper.html"
SW = ROOT / "sampling_sw.js"
VER_FILE = ROOT / "version.txt"

PATTERN = re.compile(r"b(\d{8})-(\d+)")


def current_version():
    if VER_FILE.exists():
        v = VER_FILE.read_text(encoding="utf-8-sig").strip()
        if PATTERN.fullmatch(v):
            return v
    found = PATTERN.findall(HTML.read_text(encoding="utf-8"))
    if not found:
        sys.exit("找不到当前版本号")
    date, build = max((d, int(b)) for d, b in found)
    return f"b{date}-{build}"


def next_version(cur):
    date, build = PATTERN.fullmatch(cur).groups()
    build = int(build)
    today = dt.date.today().strftime("%Y%m%d")
    return f"b{today}-{build + 1}" if today == date else f"b{today}-101"


def main(argv):
    dry = "--dry-run" in argv
    args = [a for a in argv if not a.startswith("--")]
    cur = current_version()
    new = args[0] if args else next_version(cur)
    if not PATTERN.fullmatch(new):
        sys.exit(f"版本号格式应为 bYYYYMMDD-NNN，收到 {new!r}")

    html = HTML.read_text(encoding="utf-8")
    hits = html.count(cur)
    if hits == 0:
        sys.exit(f"sampling_helper.html 里找不到 {cur}")

    sw = SW.read_text(encoding="utf-8")
    m = re.search(r'"sampling-v(\d+)"', sw)
    if not m:
        sys.exit("sampling_sw.js 里找不到 CACHE 版本")

    print(f"版本  {cur} -> {new}  (HTML {hits} 处)")
    print(f"缓存  sampling-v{m.group(1)} -> sampling-v{int(m.group(1)) + 1}")
    print(f"探针  version.txt = {new}")
    if dry:
        return

    HTML.write_text(html.replace(cur, new), encoding="utf-8")
    VER_FILE.write_text(new + "\n", encoding="utf-8")
    SW.write_text(sw.replace(m.group(0), f'"sampling-v{int(m.group(1)) + 1}"'), encoding="utf-8")
    print("完成：刷新页面即可在底部看到「立即更新」")


if __name__ == "__main__":
    main(sys.argv[1:])
