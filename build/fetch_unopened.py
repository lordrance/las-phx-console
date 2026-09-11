# -*- coding: utf-8 -*-
"""
Fetch every ZIP code in Arizona / Nevada / Utah so the map can show the ones we
do NOT serve ("未开邮编") and so search finds them.

Two sources, because neither alone is complete:

  * US Census TIGERweb ZCTA5 (2020)  -> polygon boundaries.
    ZCTAs only exist for areas with population, so PO-Box-only ZIPs have none.
  * GeoNames US postal code export   -> city name + state + point for EVERY ZIP,
    including the PO-Box-only ones that have no polygon.

Boundaries are pulled at the SAME maxAllowableOffset as fetch_geo.py uses for the
served zips. Mixing simplification levels would leave visible slivers where a
served zip touches an unserved one, so both layers must be generated alike.

Output: unopened.json  (consumed by assemble.py)
"""
import io
import json
import os
import time
import urllib.parse
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

ZCTA = ("https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/"
        "tigerWMS_Current/MapServer/2/query")
GEONAMES = "https://download.geonames.org/export/zip/US.zip"

# must match fetch_geo.py, see module docstring
OFFSET = "0.001"
PRECISION = "5"
BATCH = 40

STATES = ("AZ", "NV", "UT")
# ZIP prefixes are assigned by state and are exact for these three:
#   UT 84xxx   AZ 85xxx/86xxx   NV 889xx/89xxx
WHERE = ("ZCTA5 LIKE '84%' OR ZCTA5 LIKE '85%' OR ZCTA5 LIKE '86%' "
         "OR ZCTA5 LIKE '889%' OR ZCTA5 LIKE '89%'")


def get(url, timeout=180, tries=3):
    for k in range(tries):
        try:
            return urllib.request.urlopen(url, timeout=timeout).read()
        except Exception as e:
            if k == tries - 1:
                raise
            print(f"      retry {k+1}: {e}")
            time.sleep(3)


def served_zips():
    """The zips this dashboard already covers -- read from the built mapdata."""
    with open(os.path.join(HERE, "mapdata.json"), encoding="utf-8") as f:
        md = json.load(f)
    out = set()
    for st in md["stations"].values():
        for z in st["zips"]:
            out.add(str(z["zip"]))
    return out


def geonames_zips():
    """zip -> (city, state) for every ZIP in AZ/NV/UT, plus a fallback point."""
    print("[1] 下载 GeoNames 全美邮编库")
    raw = get(GEONAMES, timeout=240)
    print(f"    {len(raw)/1024/1024:.1f} MB")
    zf = zipfile.ZipFile(io.BytesIO(raw))
    txt = zf.read("US.txt").decode("utf-8")
    out = {}
    for line in txt.split("\n"):
        p = line.split("\t")
        if len(p) < 12 or p[4] not in STATES:
            continue
        z = p[1].strip()
        if len(z) != 5 or not z.isdigit():
            continue
        try:
            lat, lon = float(p[9]), float(p[10])
        except ValueError:
            continue
        # a ZIP can appear on several lines (multiple place names); keep the first
        out.setdefault(z, {"city": p[2].strip(), "state": p[4], "lat": lat, "lon": lon})
    by_state = {}
    for v in out.values():
        by_state[v["state"]] = by_state.get(v["state"], 0) + 1
    print(f"    AZ/NV/UT 邮编 {len(out)} 个: "
          + ", ".join(f"{k} {by_state[k]}" for k in sorted(by_state)))
    return out


def fetch_ids():
    raw = get(ZCTA + "?" + urllib.parse.urlencode(
        {"where": WHERE, "outFields": "ZCTA5", "returnGeometry": "false", "f": "json"}))
    j = json.loads(raw)
    if j.get("exceededTransferLimit"):
        raise SystemExit("ZCTA 属性查询被截断,需要分页")
    return sorted(f["attributes"]["ZCTA5"] for f in j.get("features", []))


def fetch_boundaries(zips):
    feats, cent = {}, {}
    total_kb = 0
    for i in range(0, len(zips), BATCH):
        chunk = zips[i:i + BATCH]
        raw = get(ZCTA + "?" + urllib.parse.urlencode(
            {"where": "ZCTA5 IN (%s)" % ",".join("'%s'" % z for z in chunk),
             "outFields": "ZCTA5,INTPTLAT,INTPTLON", "returnGeometry": "true",
             "f": "geojson", "outSR": "4326",
             "maxAllowableOffset": OFFSET, "geometryPrecision": PRECISION}))
        total_kb += len(raw) / 1024
        for f in json.loads(raw).get("features", []):
            z = f["properties"]["ZCTA5"]
            feats[z] = f["geometry"]
            cent[z] = (float(f["properties"]["INTPTLAT"]),
                       float(f["properties"]["INTPTLON"]))
        print(f"    批次 {i//BATCH+1:>2}/{(len(zips)+BATCH-1)//BATCH}: "
              f"累计 {len(feats)} 个多边形, {total_kb/1024:.2f} MB")
    return feats, cent


def main():
    served = served_zips()
    print(f"已开通邮编 {len(served)} 个\n")

    gn = geonames_zips()

    print("\n[2] 查询 AZ/NV/UT 全部 ZCTA 编号")
    all_zcta = fetch_ids()
    print(f"    {len(all_zcta)} 个 ZCTA")

    # every ZIP known from either source, minus the ones we already serve
    universe = set(all_zcta) | set(gn)
    unopened = sorted(universe - served)
    print(f"\n    两个来源合并 {len(universe)} 个邮编"
          f" -> 未开通 {len(unopened)} 个")

    want_geom = [z for z in unopened if z in set(all_zcta)]
    print(f"\n[3] 拉取未开通邮编边界 ({len(want_geom)} 个, offset={OFFSET})")
    feats, cent = fetch_boundaries(want_geom)

    zips = {}
    no_geom = []
    for z in unopened:
        g = gn.get(z)
        if z in cent:
            lat, lon = cent[z]
        elif g:
            lat, lon = g["lat"], g["lon"]
        else:
            continue                       # no boundary and no point: unusable
        state = g["state"] if g else ("UT" if z[:2] == "84" else
                                      "AZ" if z[:2] in ("85", "86") else "NV")
        rec = {"c": (g["city"] if g else ""), "s": state,
               "lat": round(lat, 5), "lon": round(lon, 5)}
        if z not in feats:
            rec["ng"] = 1
            no_geom.append(z)
        zips[z] = rec

    fc = {"type": "FeatureCollection",
          "features": [{"type": "Feature", "properties": {"zip": z},
                        "geometry": feats[z]} for z in sorted(feats)]}

    # city names for the SERVED zips too, so popups and search read the same
    # way on both sides of the opened/unopened line
    cities = {z: gn[z]["city"] for z in sorted(served) if z in gn}

    out = {"zips": zips, "geo": fc, "cities": cities,
           "meta": {"states": list(STATES), "offset": OFFSET,
                    "served": len(served), "unopened": len(zips),
                    "with_geom": len(feats), "no_geom": len(no_geom)}}
    path = os.path.join(HERE, "unopened.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)

    mb = os.path.getsize(path) / 1024 / 1024
    pts = sum(sum(len(r) for r in g["coordinates"])
              if g["type"] == "Polygon"
              else sum(len(r) for p in g["coordinates"] for r in p)
              for g in feats.values())
    print(f"\n写出 unopened.json  {mb:.2f} MB")
    print(f"   未开通邮编 {len(zips)} 个,其中 {len(feats)} 个有边界、"
          f"{len(no_geom)} 个只有坐标点(PO Box 专用)")
    print(f"   边界总坐标点 {pts:,},平均每个邮编 {pts/max(len(feats),1):.0f} 点")
    if no_geom:
        print(f"   无边界: {', '.join(no_geom[:25])}"
              + (" ..." if len(no_geom) > 25 else ""))


if __name__ == "__main__":
    main()
