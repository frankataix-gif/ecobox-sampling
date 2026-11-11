"""从 icon.svg 生成 PWA / iOS 需要的 PNG 图标（192/512/maskable/apple-touch）。

用法：py -3.12 devtools/make_icons.py
"""
import asyncio, base64, io, sys, pathlib
from playwright.async_api import async_playwright

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
ROOT = pathlib.Path(__file__).resolve().parent.parent
SVG = "data:image/svg+xml;base64," + base64.b64encode((ROOT / "icon.svg").read_bytes()).decode()

OUT = {
    "icon-192.png": dict(size=192),
    "icon-512.png": dict(size=512),
    "icon-maskable-512.png": dict(size=512, pad=0.1, opaque=True),
    "apple-touch-icon.png": dict(size=180, pad=0.06, opaque=True),
}


async def shot(pg, size, path, pad=0.0, opaque=False):
    inner_px = round(size * (1 - pad * 2))
    m = round(size * pad)
    bg = "#1668dc" if opaque else "transparent"
    html = (
        f'<html><body style="margin:0;background:{bg}">'
        f'<div id="t" style="width:{size}px;height:{size}px;background:{bg}">'
        f'<img src="{SVG}" style="width:{inner_px}px;height:{inner_px}px;display:block;margin:{m}px">'
        "</div></body></html>"
    )
    await pg.set_viewport_size({"width": size, "height": size})
    await pg.set_content(html)
    await pg.wait_for_timeout(250)
    el = await pg.query_selector("#t")
    await el.screenshot(path=str(path), omit_background=not opaque)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page()
        for name, kw in OUT.items():
            await shot(pg, path=ROOT / name, **kw)
        await b.close()
    from PIL import Image
    for name in OUT:
        im = Image.open(ROOT / name)
        print(name, im.size, im.mode, f"{len((ROOT / name).read_bytes()) // 1024} KB")


asyncio.run(main())
