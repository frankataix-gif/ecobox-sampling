"""Publish the licence outlines of a project to R2 so the live pages can use them.

geo/ stays out of the public repo; the geojson is served from the media worker
instead (same outlet as report images).

    python devtools/publish_geo.py serenje-1330nw
    python devtools/publish_geo.py serenje-1330nw --check

Token: $MEDIA_TOKEN, else the DEF_MEDIA_TOKEN already shipped in
sampling_helper.html (it is a public upload token for this bucket).
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MEDIA = "https://ecobox-media.frankataix.workers.dev"


def media_token():
    tok = os.environ.get("MEDIA_TOKEN", "").strip()
    if tok:
        return tok
    html = (ROOT / "sampling_helper.html").read_text(encoding="utf-8")
    m = re.search(r'DEF_MEDIA_TOKEN="([^"]+)"', html)
    if not m:
        sys.exit("cannot find DEF_MEDIA_TOKEN in sampling_helper.html")
    return m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug", help="project geo slug, e.g. serenje-1330nw")
    ap.add_argument("--file", help="default: geo/<slug>/licences.geojson")
    ap.add_argument("--check", action="store_true", help="only verify the published file")
    a = ap.parse_args()

    key = f"geo/{a.slug}/licences.geojson"
    url = f"{MEDIA}/m/{key}"
    src = Path(a.file) if a.file else ROOT / "geo" / a.slug / "licences.geojson"

    if not a.check:
        body = src.read_bytes()
        doc = json.loads(body.decode("utf-8-sig"))
        feats = doc.get("features") or []
        if not feats:
            sys.exit(f"{src} has no features")
        print(f"upload {src.name}: {len(body)} B, {len(feats)} polygons -> {key}")
        req = urllib.request.Request(f"{MEDIA}/put?key={urllib.parse.quote(key)}",
                                     data=body, method="POST",
                                     headers={"X-Upload-Token": media_token(),
                                              "Origin": "https://frankataix-gif.github.io",
                                              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
                                              "Content-Type": "application/geo+json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                print("upload:", r.status, r.read().decode()[:120])
        except urllib.error.HTTPError as e:
            sys.exit(f"upload failed: {e.code} {e.read().decode()[:200]}")

    ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"}
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=ua), timeout=60) as r:
            live = r.read()
        doc = json.loads(live.decode("utf-8-sig"))
        print(f"live {url}: {r.status}, {len(live)} B, {len(doc.get('features') or [])} features")
        for f in doc.get("features") or []:
            print("   ", (f.get("properties") or {}).get("no"),
                  (f.get("geometry") or {}).get("type"))
        if not a.check:
            print("bytes match:", live == body)
    except urllib.error.HTTPError as e:
        print(f"live {url}: HTTP {e.code}")


if __name__ == "__main__":
    main()
