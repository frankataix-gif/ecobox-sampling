#!/usr/bin/env python3
"""把 ecobox（QGIS/网页端）导出的 samples.json 转成 sampling_helper 能「从备份文件恢复」的格式。

源格式（另一套软件导出）：
  {"note": "...", "deleted": ["S...", ...], "samples": [
     {"sample_id","area_id","lon","lat","symbol","mineral","sample_type","description",
      "ta2o5_pct","nb2o5_pct","li2o_pct","cs_ppm","be_ppm","sn_ppm","assays","photos"(URL 数组),
      "source","datetime","status"(中文),"recorder","license_no","category","subtype","photo_ai"}]}

目标格式（sampling_helper 备份）：
  {"app":"ecobox-sampling","exported_at":..., "areas":[...], "samples":[...], "trips":[]}
  记录字段：sample_id / kind / sample_time / created_at / latitude / longitude /
            sample_type / area_id / area_name / description / remark / recorder /
            status(pending|synced) / photos[{name,kind,key,url}] / assays[{element,value,unit}] / erp_name

用法：
  py -3.12 devtools/import_legacy_samples.py "samples (2).json" -o import_ready.json
  py -3.12 devtools/import_legacy_samples.py samples.json --status synced --dry-run
"""
import argparse
import datetime as dt
import io
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AREAS_JSON = os.path.join(ROOT, "areas.json")
MEDIA_MARK = "/m/"          # R2 直链前缀，key 从它后面取
ASSAY_FIELDS = [            # 旧表的化验列 → (元素, 单位)
    ("ta2o5_pct", "Ta2O5", "%"),
    ("nb2o5_pct", "Nb2O5", "%"),
    ("li2o_pct", "Li2O", "%"),
    ("cs_ppm", "Cs", "ppm"),
    ("be_ppm", "Be", "ppm"),
    ("sn_ppm", "Sn", "ppm"),
]


def load_areas():
    try:
        with io.open(AREAS_JSON, encoding="utf-8") as f:
            doc = json.load(f)
        return {str(a["id"]): a for a in doc.get("areas", []) if a.get("id")}
    except Exception:
        return {}


def to_time(s, sample_id=""):
    """'2026-10-12T16:03:55' / '2026-10-12 16:03:55' → ('2026-10-12 16:03:55', '2026-10-12T16:03:55')

    没有时间时从编号推日期（S20261012-003 → 2026-10-12 00:00:00），旧编号（SER-002）推不出就留空。
    """
    if not s and sample_id:
        m = re.match(r"^[A-Za-z]{1,3}(\d{4})(\d{2})(\d{2})-", sample_id)
        if m:
            s = f"{m.group(1)}-{m.group(2)}-{m.group(3)}T00:00:00"
    if not s:
        return "", ""
    raw = str(s).strip().replace("T", " ")
    raw = raw.split(".")[0].split("+")[0]          # 去掉毫秒/时区
    try:
        t = dt.datetime.strptime(raw[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return raw, raw.replace(" ", "T")
    return t.strftime("%Y-%m-%d %H:%M:%S"), t.strftime("%Y-%m-%dT%H:%M:%S")


def photo_key(url):
    return url.split(MEDIA_MARK, 1)[1] if MEDIA_MARK in url else ""


def norm_photo(p, sample_id, idx):
    if isinstance(p, str):                         # 旧格式只存 URL
        url = p.strip()
        key = photo_key(url)
        name = os.path.basename(key or url) or f"{idx:02d}.jpg"
        return {"name": name, "kind": "field", "key": key, "url": url, "external": True}
    if isinstance(p, dict):
        out = dict(p)
        if not out.get("name"):
            out["name"] = os.path.basename(out.get("key") or "") or f"{sample_id}-{idx:02d}"
        out.setdefault("kind", "field")
        if not out.get("key") and out.get("url"):
            out["key"] = photo_key(out["url"])
        return out
    return None


def num(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def convert(src, areas, status):
    out = []
    skipped = []
    for s in src:
        sid = (s.get("sample_id") or "").strip()
        lat, lon = num(s.get("lat", s.get("latitude"))), num(s.get("lon", s.get("longitude")))
        if not sid or lat is None or lon is None:
            skipped.append(sid or "(无编号)")
            continue
        stamp, iso = to_time(s.get("datetime") or s.get("sample_time") or s.get("created_at"), sid)
        aid = str(s.get("area_id") or "")
        assays = [{"element": a.get("element"), "value": a.get("value"), "unit": a.get("unit") or ""}
                  for a in (s.get("assays") or []) if a.get("element") and a.get("value") not in (None, "")]
        have = {a["element"] for a in assays}
        for col, el, unit in ASSAY_FIELDS:
            v = num(s.get(col))
            if v is not None and el not in have:
                assays.append({"element": el, "value": v, "unit": unit})
        photos = [p for p in (norm_photo(p, sid, i + 1) for i, p in enumerate(s.get("photos") or [])) if p]
        rec = {
            "sample_id": sid,
            "kind": "marker" if (s.get("category") == "标记点") else "sample",
            "sample_time": stamp,
            "created_at": iso,
            "latitude": lat,
            "longitude": lon,
            "sample_type": (s.get("subtype") or s.get("sample_type") or ""),
            "area_id": aid,
            "area_name": (areas.get(aid) or {}).get("name", ""),
            "description": s.get("description") or "",
            "remark": s.get("remark") or "",
            "recorder": s.get("recorder") or "",
            "status": status,
            "photos": photos,
            "assays": assays,
            "erp_name": s.get("erp_name") or "",
        }
        for keep in ("symbol", "mineral", "license_no", "category", "subtype", "source", "photo_ai",
                     "status_source", "loc_status", "altitude"):
            if s.get(keep) not in (None, ""):
                rec[keep] = s[keep]
        out.append(rec)
    return out, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src", help="samples.json（另一套软件导出）")
    ap.add_argument("-o", "--out", default="import_ready_samples.json")
    ap.add_argument("--status", choices=["pending", "synced"], default="pending",
                    help="导入后按待同步还是已同步标记（默认 pending，会尝试上传到云端）")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    with io.open(a.src, encoding="utf-8-sig") as f:
        doc = json.load(f)
    arr = doc["samples"] if isinstance(doc, dict) else doc
    deleted = set(doc.get("deleted") or []) if isinstance(doc, dict) else set()
    arr = [s for s in arr if s.get("sample_id") not in deleted]

    areas = load_areas()
    samples, skipped = convert(arr, areas, a.status)
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"源记录 {len(arr)} 条（已剔除 deleted {len(deleted)} 个编号）→ 可导入 {len(samples)} 条")
    if skipped:
        print("跳过（缺编号/坐标）：", ", ".join(skipped))
    print(f"照片 {sum(len(s['photos']) for s in samples)} 张（URL 直链，不占本机空间）")
    print(f"化验值 {sum(len(s['assays']) for s in samples)} 个")
    print("状态：", a.status)
    for s in samples:
        print(f"  {s['sample_id']:<16} {s['sample_time']}  ({s['latitude']:.5f},{s['longitude']:.5f})  "
              f"{s['area_name'] or s['area_id']}  {s['sample_type']}  📷{len(s['photos'])}  🧪{len(s['assays'])}")
    if a.dry_run:
        print("（--dry-run，不写文件）")
        return 0

    out = {
        "app": "ecobox-sampling",
        "exported_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "areas": list(areas.values()),
        "samples": samples,
        "trips": [],
    }
    with io.open(a.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"已写入 {a.out}（{os.path.getsize(a.out)} 字节）")
    print("导入方式：取样助手 → 设置 → 📥 从备份文件恢复（选这个文件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
