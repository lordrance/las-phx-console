# -*- coding: utf-8 -*-
"""
Assemble las-phx/index.html from the pieces in this folder.

The design system lives in base.css, forked once from the 北加 console so this
dashboard carries no dependency on that file and no NorCal data. Run
`python assemble.py` after editing any piece.
"""
import os
import re
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
OUTDIR = os.path.abspath(os.path.join(HERE, ".."))

PRICE_LOADER = r"""
(function(){
  "use strict";
  const md = document.getElementById('mapdata');
  const data = JSON.parse(md.textContent);
  const statusEl = document.getElementById('pricesheet-status');

  function parseCsv(text){
    const rows = [];
    text.split(/\r?\n/).forEach(line => {
      const parts = line.split(',').map(s => s.trim().replace(/^"|"$/g,''));
      if (parts.length < 2) return;
      const zip = parts[0], price = parseFloat(parts[1]);
      if (/^\d{5}$/.test(zip) && isFinite(price) && price > 0) rows.push({ zip, price });
    });
    return rows;
  }

  // Apply overrides, then recompute every derived price aggregate
  function applyPriceSheet(rows){
    const byZip = {}; rows.forEach(r => byZip[r.zip] = r.price);
    let changed = 0;
    Object.values(data.stations).forEach(st => {
      st.zips.forEach(z => {
        const p = byZip[z.zip];
        if (p !== undefined && Math.abs(p - z.price) > 1e-9) { z.price = p; changed++; }
      });
      // route price = volume-weighted mean of member ZIP prices
      const members = {};
      st.zips.forEach(z => Object.entries(z.routes).forEach(([rt, v]) => {
        (members[rt] = members[rt] || []).push({ price: z.price, vol: v });
      }));
      st.routes.forEach(r => {
        const m = members[r.route] || [];
        if (!m.length) return;
        const tv = m.reduce((s, x) => s + x.vol, 0);
        r.price = +(tv > 0
          ? m.reduce((s, x) => s + x.price * x.vol, 0) / tv
          : m.reduce((s, x) => s + x.price, 0) / m.length).toFixed(3);
      });
      const priced = st.zips.filter(z => z.price > 0);
      const tv = priced.reduce((s, z) => s + z.volume, 0);
      if (priced.length) st.avg_price = +(tv > 0
        ? priced.reduce((s, z) => s + z.price * z.volume, 0) / tv
        : priced.reduce((s, z) => s + z.price, 0) / priced.length).toFixed(3);
    });
    Object.keys(data.dsp_summary).forEach(dsp => {
      let sv = 0, sp = 0, n = 0, simple = 0;
      Object.values(data.stations).forEach(st => st.zips.forEach(z => {
        if (z.dsps[dsp] === undefined || z.price <= 0) return;
        sv += z.volume; sp += z.price * z.volume; n++; simple += z.price;
      }));
      if (n) data.dsp_summary[dsp].avg_price = +((sv > 0 ? sp / sv : simple / n)).toFixed(3);
    });
    return changed;
  }

  function boot(){
    md.textContent = JSON.stringify(data);
    new Function(document.getElementById('mapmain').textContent)();
  }
  function setStatus(cls, html){ statusEl.className = 'ps-status ' + cls; statusEl.innerHTML = html; }

  // Opened straight off disk the browser blocks this fetch, so say so plainly
  // rather than leaving a message that reads like a failure.
  const offDisk = location.protocol === 'file:';
  if (offDisk) setStatus('preview',
    '<b>本地打开,未读取调价表</b> — 浏览器安全策略禁止 file:// 页面读取本地 CSV,'
    + '当前显示的是内置基准价格。部署到服务器后会自动读取 data/price_adjustments.csv。');

  fetch('data/price_adjustments.csv?t=' + Date.now(), { cache: 'no-store' })
    .then(r => { if (!r.ok) throw new Error('no sheet'); return r.text(); })
    .then(text => {
      const rows = parseCsv(text);
      const n = applyPriceSheet(rows);
      setStatus('applied', '<b>调价表已生效</b> — 从 data/price_adjustments.csv 读取 '
        + rows.length + ' 个邮编,其中 ' + n + ' 个与基准价不同。');
    })
    .catch(() => {
      if (!offDisk) setStatus('', '使用内置基准价格 — 未找到 data/price_adjustments.csv。');
    })
    .finally(boot);
})();
"""


def main():
    base_css = open(os.path.join(HERE, "base.css"), encoding="utf-8").read()
    extra_css = open(os.path.join(HERE, "lasphx_extra.css"), encoding="utf-8").read()
    body = open(os.path.join(HERE, "lasphx_body.html"), encoding="utf-8").read()
    app = open(os.path.join(HERE, "lasphx_app.js"), encoding="utf-8").read()
    mapdata = open(os.path.join(HERE, "mapdata.json"), encoding="utf-8").read()
    zipgeo = open(os.path.join(HERE, "zipgeo.json"), encoding="utf-8").read()

    for blob, name in ((mapdata, "mapdata"), (zipgeo, "zipgeo")):
        if "</script" in blob:
            raise SystemExit(f"{name} 含有 </script,无法安全内联")

    html = f"""<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>拉斯维加斯/凤凰城片区站点数据看板 · LAS/PHX Regional Station Data Dashboard</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>{base_css}
{extra_css}</style>
</head>
<body>
{body}
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<!-- ============================================================== -->
<!-- >>> 数据在这里 <<<  每个邮编的单量/价格/难易度,以及站点、线路、 -->
<!-- DSP 的汇总,全部在下面这一行 JSON 里。Ctrl+F 邮编(如 85043)   -->
<!-- 可直接定位。整行替换即可更新数据,不要改本文件其他部分。        -->
<!-- ============================================================== -->
<script id="mapdata" type="application/json">{mapdata}</script>
<script id="zipgeo" type="application/json">{zipgeo}</script>
<script type="text/plain" id="mapmain">
{app}
</script>
<script>{PRICE_LOADER}</script>
</body>
</html>
"""

    os.makedirs(os.path.join(OUTDIR, "data"), exist_ok=True)
    out = os.path.join(OUTDIR, "index.html")
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    csv_out = os.path.join(OUTDIR, "data", "price_adjustments.csv")
    if os.path.exists(os.path.join(HERE, "price_adjustments.csv")):
        shutil.copy(os.path.join(HERE, "price_adjustments.csv"), csv_out)

    print(f"写出 {out}")
    print(f"   总大小 {os.path.getsize(out)/1024:.0f} KB")
    print(f"     CSS  {(len(base_css)+len(extra_css))/1024:.0f} KB")
    print(f"     数据 {len(mapdata)/1024:.0f} KB + 边界 {len(zipgeo)/1024:.0f} KB")
    print(f"     应用 {len(app)/1024:.0f} KB")
    print(f"写出 {csv_out}")


if __name__ == "__main__":
    main()
