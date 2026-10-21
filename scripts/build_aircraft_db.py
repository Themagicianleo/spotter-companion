#!/usr/bin/env python3
"""Build the small per-aircraft database the info panel uses.

Run from the project folder:   python3 scripts/build_aircraft_db.py
(GitHub Actions also runs it monthly: .github/workflows/build-aircraft-db.yml)

It combines three free databases, matched by the aircraft's 24-bit hex code:

1. tar1090-db (github.com/wiedehopf/tar1090-db, csv branch): registration, type code,
   type description, year, owner/operator. No header, ';'-separated. Column order confirmed
   from readsb's parser (aircraft.c):  hex;registration;typeCode;dbFlags;typeLong;year;ownOp;
2. OpenSky Network aircraft database (opensky-network.org/data/aircraft): adds the exact model
   variant (e.g. an Airbus model number), serial number, build date and engines, where known.
   This file HAS a header row, and columns are looked up BY NAME. If a needed column is missing,
   the script stops instead of guessing. If OpenSky can't be downloaded, the build carries on
   with tar1090-db only.
3. Virtual Radar Server standing data, aircraft files (github.com/vradarserver/standing-data, CC0):
   operator, serial number, year built and model for aircraft corrected by VRS users since 2022.
   Header (confirmed from the real files): ICAO,Registration,ModelICAO,Manufacturer,Model,
   ManufacturerAndModel,IsPrivateOperator,Operator,AirlineCode,SerialNumber,YearBuilt

Kept: aircraft whose type is in data/aircraft_types.json (Boeing/Airbus airliners), plus every
Singapore-registered (9V-) aircraft of any type, since those are the ones seen most around Changi.
They're split into 16 files by the first hex character, so the page downloads one small
file per click.

Output: data/aircraft_db/<0-f>.json  and  data/aircraft_db/meta.json

It also writes data/aircraft_flags.json: the hex codes tar1090-db flags as military or
"interesting" (any type, any country). The flags column is a string of '0'/'1' characters;
readsb reads character 1 as "military" and character 2 as "interesting" (aircraft.c, dbFlags
bits 1 and 2). Characters 3-4 are privacy flags (PIA, LADD): we don't use or copy them.

Only the flags file:   python3 scripts/build_aircraft_db.py --flags-only
"""

import csv
import gzip
import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

TAR1090_URL = "https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz"
OPENSKY_BUCKET = "https://s3.opensky-network.org/data-samples"
VRS_ZIP_URL = "https://github.com/vradarserver/standing-data/archive/refs/heads/main.zip"
VRS_COLUMNS = ["ICAO", "Registration", "ModelICAO", "Model", "Operator", "SerialNumber", "YearBuilt"]
LOCAL_PREFIX = "9V-"  # keep every aircraft with this registration prefix, whatever its type
USER_AGENT = "SpottersCompanion-build/1.0 (+https://github.com/Themagicianleo/spotter-companion)"
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "aircraft_db"

# OpenSky columns we use. All must exist in the header, or we stop.
OPENSKY_COLUMNS = ["icao24", "model", "typecode", "serialNumber", "built", "engines"]  # names from the real header (2025-08 snapshot)

# Field order in the output files. The page reads these names from each file.
FIELDS = [
    "registration", "typeCode", "typeDescription", "yearBuilt", "operator",  # from tar1090-db
    "osModel", "osSerialNumber", "osBuilt", "osEngines", "osTypeCode",  # from OpenSky
    "vrsModel", "vrsSerialNumber", "vrsYearBuilt", "vrsOperator",  # from VRS standing data
]


def download(url, timeout=300):
    print(f"Downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read(), response.headers.get("Last-Modified")


def load_tar1090(wanted_types):
    raw, last_modified = download(TAR1090_URL)
    text = gzip.decompress(raw).decode("utf-8", errors="replace")
    rows = {}
    flags = {"military": [], "interesting": []}
    total = 0
    for row in csv.reader(io.StringIO(text), delimiter=";"):
        total += 1
        if len(row) < 7:
            continue
        hex_code, reg, type_code, db_flags, type_long, year, own_op = (field.strip() for field in row[:7])
        hex_code = hex_code.lower()
        if re.fullmatch(r"[0-9a-f]{6}", hex_code):
            if db_flags[:1] == "1":
                flags["military"].append(hex_code)
            if db_flags[1:2] == "1":
                flags["interesting"].append(hex_code)
        if type_code in wanted_types or reg.startswith(LOCAL_PREFIX):
            rows[hex_code] = [reg or None, type_code, type_long or None, year or None, own_op or None]
    info = {"url": TAR1090_URL, "lastModified": last_modified, "rowsInSource": total}
    return rows, info, flags


def write_flags(flags, info):
    payload = {
        "source": "tar1090-db dbFlags column (military = character 1, interesting = character 2)",
        "sourceUrl": TAR1090_URL,
        "sourceLastModified": info.get("lastModified"),
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "note": "Community-maintained flags. Some military aircraft are missing and some entries can be wrong.",
        "military": sorted(flags["military"]),
        "interesting": sorted(flags["interesting"]),
    }
    path = ROOT / "data" / "aircraft_flags.json"
    path.write_text(json.dumps(payload, separators=(",", ":")))
    print(f"Flags: {len(payload['military']):,} military, {len(payload['interesting']):,} interesting -> {path}")


def latest_opensky_key():
    """Find the newest 'aircraft-database-complete-YYYY-MM.csv' in OpenSky's public bucket."""
    listing, _ = download(f"{OPENSKY_BUCKET}?list-type=2&prefix=metadata/", timeout=60)
    keys = re.findall(r"<Key>([^<]+)</Key>", listing.decode("utf-8", errors="replace"))
    print(f"OpenSky bucket metadata/ files: {keys}")
    snapshots = sorted(k for k in keys if re.search(r"aircraft-database-complete-\d{4}-\d{2}\.csv$", k))
    if snapshots:
        return snapshots[-1]
    if "metadata/aircraftDatabase.csv" in keys:
        return "metadata/aircraftDatabase.csv"
    raise RuntimeError("No aircraft database file found in the OpenSky bucket listing")


def load_opensky(wanted_types, tar_rows):
    key = latest_opensky_key()
    url = f"{OPENSKY_BUCKET}/{key}"
    raw, last_modified = download(url)
    text = raw.decode("utf-8", errors="replace")
    # Some OpenSky snapshots quote values with ' instead of ". Detect it from the header line.
    quote = "'" if text.lstrip().startswith("'") else '"'
    reader = csv.DictReader(io.StringIO(text), quotechar=quote)
    header = reader.fieldnames or []
    print(f"OpenSky header ({len(header)} columns): {header}")
    missing = [c for c in OPENSKY_COLUMNS if c not in header]
    if missing:
        raise RuntimeError(f"OpenSky file ({key}) is missing expected columns {missing}; not guessing. "
                           f"Its header is: {header}; first data line: {text.splitlines()[1][:400]!r}")

    rows = {}
    total = 0
    filled = {c: 0 for c in OPENSKY_COLUMNS}
    for r in reader:
        total += 1
        hex_code = (r.get("icao24") or "").strip().lower()
        if not re.fullmatch(r"[0-9a-f]{6}", hex_code):
            continue
        typecode = (r.get("typecode") or "").strip().upper()
        # Keep it if it's one of our types, already in tar1090-db, or Singapore-registered.
        registration = (r.get("registration") or "").strip().upper()
        if typecode not in wanted_types and hex_code not in tar_rows and not registration.startswith(LOCAL_PREFIX):
            continue
        values = {c: (r.get(c) or "").strip() or None for c in OPENSKY_COLUMNS}
        for c, v in values.items():
            if v:
                filled[c] += 1
        rows[hex_code] = [values["model"], values["serialNumber"], values["built"], values["engines"], typecode or None]
    info = {"url": url, "lastModified": last_modified, "rowsInSource": total, "columns": header,
            "filledCountsForKeptRows": filled, "quoteChar": quote}
    return rows, info


def load_vrs(wanted_types, known_hexes):
    """Aircraft files from the VRS standing data (CC0). Columns are read by name from the header."""
    raw, _ = download(VRS_ZIP_URL)
    archive = zipfile.ZipFile(io.BytesIO(raw))
    rows, files = {}, 0
    for name in archive.namelist():
        if "/aircraft/schema-01/" not in name or not name.endswith(".csv"):
            continue
        files += 1
        reader = csv.DictReader(io.StringIO(archive.read(name).decode("utf-8-sig")))
        missing = [c for c in VRS_COLUMNS if c not in (reader.fieldnames or [])]
        if missing:
            raise RuntimeError(f"VRS file {name} is missing columns {missing}; not guessing. Header: {reader.fieldnames}")
        for r in reader:
            hex_code = (r["ICAO"] or "").strip().lower()
            if not re.fullmatch(r"[0-9a-f]{6}", hex_code):
                continue
            reg = (r["Registration"] or "").strip().upper()
            if r["ModelICAO"] not in wanted_types and hex_code not in known_hexes and not reg.startswith(LOCAL_PREFIX):
                continue
            clean = lambda v: (v or "").strip() or None
            rows[hex_code] = [clean(r["Model"]), clean(r["SerialNumber"]), clean(r["YearBuilt"]), clean(r["Operator"])]
    return rows, {"url": VRS_ZIP_URL, "files": files, "rowsKept": len(rows)}


def main():
    wanted_types = {t["icao"] for t in json.loads((ROOT / "data" / "aircraft_types.json").read_text())["types"]}
    tar_rows, tar_info, flags = load_tar1090(wanted_types)
    write_flags(flags, tar_info)
    if "--flags-only" in sys.argv:
        return
    try:
        os_rows, os_info = load_opensky(wanted_types, tar_rows)
    except Exception as err:  # OpenSky down or moved: carry on without it, and say so
        print(f"WARNING: OpenSky database not used: {err}")
        os_rows, os_info = {}, {"error": str(err)}

    try:
        vrs_rows, vrs_info = load_vrs(wanted_types, set(tar_rows) | set(os_rows))
    except Exception as err:  # carry on without it, and say so
        print(f"WARNING: VRS aircraft data not used: {err}")
        vrs_rows, vrs_info = {}, {"error": str(err)}

    shards = {c: {} for c in "0123456789abcdef"}
    for hex_code in set(tar_rows) | set(os_rows) | set(vrs_rows):
        tar = tar_rows.get(hex_code, [None, None, None, None, None])
        osk = os_rows.get(hex_code, [None, None, None, None, None])
        vrs = vrs_rows.get(hex_code, [None, None, None, None])
        shards[hex_code[0]][hex_code] = tar + osk + vrs

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for first_char, aircraft in shards.items():
        payload = {"fields": FIELDS, "aircraft": dict(sorted(aircraft.items()))}
        (OUT_DIR / f"{first_char}.json").write_text(json.dumps(payload, separators=(",", ":")))

    meta = {
        "source": "tar1090-db (from the Mictronics database) + OpenSky Network aircraft database + VRS standing data",
        "sourceUrl": "https://github.com/wiedehopf/tar1090-db",
        "openskyUrl": "https://opensky-network.org/data/aircraft",
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
        "tar1090": tar_info,
        "opensky": os_info,
        "vrs": vrs_info,
        "rowsKept": sum(len(s) for s in shards.values()),
        "typesKept": sorted(wanted_types),
        "note": "Community-maintained data. Entries can be outdated or wrong.",
    }
    (OUT_DIR / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"Kept {meta['rowsKept']:,} aircraft -> {OUT_DIR}")


if __name__ == "__main__":
    main()
