"""把本地 HEAD 的内容备份到 GitHub。

远端历史与本地不同源，且普通 token 没有写权限，所以走 REST：按本地 HEAD 的树
建一次快照提交（parent 接远端原 head），只上传有差异的文件。
用法：python ops/tools/backup_github.py [--message "说明"]
需要环境变量 GITHUB_DATA_TOKEN（classic PAT，repo scope）。
"""
import argparse, base64, json, os, subprocess, sys, time, urllib.error, urllib.request

SLUG = "frankataix-gif/ecobox-sampling"
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def api(method, path, data=None):
    body = json.dumps(data).encode() if data is not None else None
    req = urllib.request.Request("https://api.github.com" + path, method=method, data=body, headers={
        "Authorization": "Bearer " + os.environ["GITHUB_DATA_TOKEN"],
        "User-Agent": "ecobox-backup",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
    })
    for i in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (502, 503, 504) and i < 3:
                time.sleep(2)
                continue
            raise SystemExit("HTTP %s %s %s" % (e.code, path, e.read()[:300].decode("utf-8", "replace")))


def git(*args, raw=False):
    out = subprocess.run(["git", "-C", ROOT] + list(args), capture_output=True, check=True).stdout
    return out if raw else out.decode("utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--message", default="")
    args = ap.parse_args()

    head = api("GET", "/repos/%s/git/ref/heads/main" % SLUG)["object"]["sha"]
    base_tree = api("GET", "/repos/%s/git/commits/%s" % (SLUG, head))["tree"]["sha"]
    remote = {t["path"]: t["sha"]
              for t in api("GET", "/repos/%s/git/trees/%s?recursive=1" % (SLUG, head))["tree"]
              if t["type"] == "blob"}

    local = {}
    for rec in git("ls-tree", "-r", "-z", "HEAD", raw=True).split(b"\0"):
        if not rec:
            continue
        meta, path = rec.split(b"\t", 1)
        mode, _typ, sha = meta.decode().split()
        local[path.decode()] = (mode, sha)

    entries, changed = [], 0
    for path, (mode, sha) in local.items():
        if remote.get(path) == sha:
            continue
        blob = api("POST", "/repos/%s/git/blobs" % SLUG, {
            "content": base64.b64encode(git("cat-file", "blob", sha, raw=True)).decode(),
            "encoding": "base64",
        })
        entries.append({"path": path, "mode": "100755" if mode == "100755" else "100644",
                        "type": "blob", "sha": blob["sha"]})
        changed += 1
        print("  +", path)
    for path in remote:
        if path not in local:
            entries.append({"path": path, "mode": "100644", "type": "blob", "sha": None})
            print("  -", path)

    if not entries:
        print("远端已是最新，无需提交")
        return
    msg = args.message or ("备份：%s\n\n本地 HEAD %s 的快照。\n\n"
                           "This commit was created by an AI agent (OpenHands) on behalf of the repository owner.\n" %
                           (time.strftime("%Y-%m-%d %H:%M"), git("rev-parse", "--short", "HEAD").strip()))
    tree = api("POST", "/repos/%s/git/trees" % SLUG, {"base_tree": base_tree, "tree": entries})
    commit = api("POST", "/repos/%s/git/commits" % SLUG,
                 {"message": msg, "tree": tree["sha"], "parents": [head]})
    api("PATCH", "/repos/%s/git/refs/heads/main" % SLUG, {"sha": commit["sha"], "force": False})
    print("已备份", commit["sha"][:10], "文件变化", changed)


if __name__ == "__main__":
    sys.exit(main())
