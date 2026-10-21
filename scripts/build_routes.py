#!/usr/bin/env python3
"""Build data/routes.json: flight routes (callsign -> airports) that pass near Singapore.

Source: Virtual Radar Server "standing data" (github.com/vradarserver/standing-data), CC0,
the same route data adsb.lol uses. Formats confirmed from the real files:
    routes/schema-01/<letter>/<code>-all.csv   Callsign,Code,Number,AirlineCode,AirportCodes
    airports/schema-01/<letter>/<2 chars>.csv  Code,Name,ICAO,IATA,Location,CountryISO2,Latitude,Longitude,AltitudeFeet
AirportCodes looks like "ZSFZ-WSSS" (can have stops: "EGLL-OMDB-WSSS").

The full data has ~620,000 routes (23 MB), far too much for a web page, so only routes whose
path (great-circle line between consecutive airports) passes within RADIUS_NM of CENTER are kept.

Run:  python3 scripts/build_routes.py                  (downloads the data)
      python3 scripts/build_routes.py path/to/standing-data   (uses a local copy)
GitHub Actions runs it monthly with the aircraft database (.github/workflows/build-aircraft-db.yml).
"""

import csv
import io
import json
import math
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ZIP_URL = "https://github.com/vradarserver/standing-data/archive/refs/heads/main.zip"
CENTER = (1.35, 103.82)  # Singapore, same as the app's default
RADIUS_NM = 300
EARTH_NM = 3440.065
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "routes.json"


def read_files():
    """Yield (path, text) for every routes/airports CSV, from a local folder or the downloaded zip."""
    if len(sys.argv) > 1:
        base = Path(sys.argv[1])
        for path in base.glob("*/schema-01/*/*.csv"):
            yield str(path.relative_to(base)), path.read_text(encoding="utf-8-sig")
        return
    print(f"Downloading {ZIP_URL}")
    request = urllib.request.Request(ZIP_URL, headers={"User-Agent": "SpottersCompanion-build/1.0"})
    with urllib.request.urlopen(request, timeout=300) as response:
        archive = zipfile.ZipFile(io.BytesIO(response.read()))
    for name in archive.namelist():
        if name.endswith(".csv") and "/schema-01/" in name:
            yield name.split("/", 1)[1], archive.read(name).decode("utf-8-sig")


def to_xyz(lat, lon):
    la, lo = math.radians(lat), math.radians(lon)
    return (math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la))


def angle(u, v):
    return math.acos(max(-1.0, min(1.0, sum(a * b for a, b in zip(u, v)))))


def distance_to_segment_nm(p, a, b):
    """Shortest distance (nm) from point p to the great-circle segment a-b."""
    P, A, B = to_xyz(*p), to_xyz(*a), to_xyz(*b)
    n = (A[1] * B[2] - A[2] * B[1], A[2] * B[0] - A[0] * B[2], A[0] * B[1] - A[1] * B[0])
    length = math.sqrt(sum(x * x for x in n))
    if length < 1e-12:  # a and b are the same place
        return angle(P, A) * EARTH_NM
    n = tuple(x / length for x in n)
    cross = math.asin(max(-1.0, min(1.0, sum(x * y for x, y in zip(P, n)))))
    # Closest point on the full great circle; is it between a and b?
    c = tuple(P[i] - math.sin(cross) * n[i] for i in range(3))
    c_len = math.sqrt(sum(x * x for x in c))
    if c_len > 1e-12:
        c = tuple(x / c_len for x in c)
        if abs(angle(A, c) + angle(c, B) - angle(A, B)) < 1e-6:
            return abs(cross) * EARTH_NM
    return min(angle(P, A), angle(P, B)) * EARTH_NM


def main():
    airports, route_rows = {}, []
    for path, text in read_files():
        rows = csv.DictReader(io.StringIO(text))
        if path.startswith("airports/"):
            for r in rows:
                try:
                    airports[r["Code"]] = {"name": r["Name"], "icao": r["ICAO"] or None, "iata": r["IATA"] or None,
                                           "city": r["Location"] or None, "country": r["CountryISO2"] or None,
                                           "lat": float(r["Latitude"]), "lon": float(r["Longitude"])}
                except (KeyError, ValueError):
                    pass
        elif path.startswith("routes/"):
            route_rows.extend((r["Callsign"], r["AirportCodes"]) for r in rows)

    routes, used = {}, set()
    for callsign, codes in route_rows:
        stops = codes.split("-")
        if len(stops) < 2 or any(c not in airports for c in stops):
            continue
        points = [(airports[c]["lat"], airports[c]["lon"]) for c in stops]
        if any(distance_to_segment_nm(CENTER, a, b) <= RADIUS_NM for a, b in zip(points, points[1:])):
            routes[callsign] = codes
            used.update(stops)

    doc = {
        "_about": "Callsign -> airport codes for routes passing within "
                  f"{RADIUS_NM} nm of {CENTER}. Built by scripts/build_routes.py.",
        "source": "Virtual Radar Server standing data (CC0), https://github.com/vradarserver/standing-data",
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "routesInSource": len(route_rows),
        "airports": {code: airports[code] for code in sorted(used)},
        "routes": dict(sorted(routes.items())),
    }
    OUT.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    print(f"Kept {len(routes):,} of {len(route_rows):,} routes, {len(used):,} airports -> {OUT} "
          f"({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
