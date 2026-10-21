#!/usr/bin/env python3
"""Build the small per-aircraft database the info panel uses.

Run from the project folder:   python3 scripts/build_aircraft_db.py
(or pass a local copy:         python3 scripts/build_aircraft_db.py path/to/aircraft.csv.gz)

Why: the full tar1090-db file is ~8 MB compressed / ~32 MB uncompressed (620,000+ aircraft),
too big for a web page to download. We keep only aircraft whose type is in
data/aircraft_types.json (the Boeing/Airbus airliners) and split them into 16 files by the
first character of the hex code, so the page downloads one small file when you click a plane.

Input format (no header, ';'-separated). Column names confirmed from readsb's parser
(aircraft.c) that reads this exact file:
    hex ; registration ; typeCode ; dbFlags ; typeLong ; year ; ownOp ; (empty)

Output: data/aircraft_db/<0-f>.json  and  data/aircraft_db/meta.json
"""

import csv
import gzip
import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SOURCE_URL = "https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz"
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "aircraft_db"


def load_csv_bytes():
    if len(sys.argv) > 1:
        print(f"Reading {sys.argv[1]}")
        return Path(sys.argv[1]).read_bytes(), None
    print(f"Downloading {SOURCE_URL} ...")
    request = urllib.request.Request(SOURCE_URL, headers={"User-Agent": "SpottersCompanion-build/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return response.read(), response.headers.get("Last-Modified")


def main():
    wanted_types = {t["icao"] for t in json.loads((ROOT / "data" / "aircraft_types.json").read_text())["types"]}
    raw, last_modified = load_csv_bytes()
    text = gzip.decompress(raw).decode("utf-8", errors="replace")

    shards = {c: {} for c in "0123456789abcdef"}
    total = kept = 0
    for row in csv.reader(io.StringIO(text), delimiter=";"):
        total += 1
        if len(row) < 7:
            continue
        hex_code, reg, type_code, _flags, type_long, year, own_op = (field.strip() for field in row[:7])
        if type_code not in wanted_types:
            continue
        hex_code = hex_code.lower()  # the live feed uses lowercase hex
        # Store a compact list; empty strings become null ("Unknown" on the page).
        shards[hex_code[0]][hex_code] = [reg or None, type_code, type_long or None, year or None, own_op or None]
        kept += 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for first_char, aircraft in shards.items():
        payload = {"fields": ["registration", "typeCode", "typeDescription", "yearBuilt", "operator"], "aircraft": aircraft}
        (OUT_DIR / f"{first_char}.json").write_text(json.dumps(payload, separators=(",", ":")))

    meta = {
        "source": "tar1090-db (wiedehopf/tar1090-db, csv branch), built from the Mictronics aircraft database",
        "sourceUrl": "https://github.com/wiedehopf/tar1090-db",
        "sourceLastModified": last_modified,
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "rowsInSource": total,
        "rowsKept": kept,
        "typesKept": sorted(wanted_types),
        "note": "Community-maintained data. Entries can be outdated or wrong. No serial numbers in this source.",
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"Kept {kept:,} of {total:,} aircraft -> {OUT_DIR}")


if __name__ == "__main__":
    main()
