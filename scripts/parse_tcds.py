#!/usr/bin/env python3
"""Build data/aircraft_variants.json (exact model -> certified engines) from official type
certificate data sheets (TCDS).

The TCDS PDFs are downloaded and turned into text by .github/workflows/fetch-tcds.yml, which
pushes them to the "tcds-text" branch. Get them and run:

    git fetch origin tcds-text
    mkdir -p /tmp/tcds && for f in $(git ls-tree --name-only origin/tcds-text); do
        git show origin/tcds-text:$f > /tmp/tcds/$f; done
    python3 scripts/parse_tcds.py /tmp/tcds

Engine names are copied exactly as the TCDS writes them, with the file and line they came from.
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "aircraft_variants.json"

# Readable names for the documents (the URLs come from SOURCES.txt).
DOC_NAMES = {
    "ukcaa-A320-family": "UK CAA TCDS UK.TC.A.00010 (A318/A319/A320/A321)",
    "easa-A004-A330": "EASA TCDS EASA.A.004 (A330)",
    "ukcaa-A340": "UK CAA TCDS UK.TC.A.00156 (A340)",
    "easa-A151-A350": "EASA TCDS EASA.A.151 (A350)",
    "ukcaa-A380": "UK CAA TCDS UK.TC.A.00158 (A380)",
    "easa-A172-A300-A310": "EASA TCDS EASA.A.172 (A300/A310/A300-600)",
    "easa-IMA570-A220": "EASA TCDS EASA.IM.A.570 (A220 / BD-500)",
}

SUPPLEMENTS = [
    {
        "model": "A380-861", "engineCount": 4, "engines": ["Engine Alliance GP7270"],
        "source": [{"name": "EASA TCDSN EASA.A.110 (A380) - from a search-result excerpt, not parsed",
                    "url": "https://www.easa.europa.eu/en/downloads/8223/en", "line": None}],
        "note": "The UK CAA A380 TCDS does not list the A380-861.",
    },
]

MODEL = r"(A3\d\d(?:-\d{3,4}[A-Z]{0,2}|\s?B\d-\d{3}[A-Z]?))"  # A320-251N, A350-1041, A300 B4-622R
COUNT = r"(?:One|Two|Four|two|four|2|4)\s*(?:\(\d\))?"
WORDS = {"one": 1, "two": 2, "four": 4, "2": 2, "4": 4}


def clean_engine_text(text):
    """'General Electric CF6-80E1A4 or CF6-80E1A4/B turbofan engines' -> ['General Electric CF6-80E1A4', 'CF6-80E1A4/B']"""
    text = re.sub(r"\((?:MOD|modification|EASA TCDS)[^)]*\)", "", text, flags=re.I)
    text = re.split(r"(?:turbofan|turbo-fan|\bjet)\s*engines?|turbofan\b|\bGeared Turbo Fan\b|engines?\b", text, flags=re.I)[0]
    text = re.sub(r"\s+", " ", text).strip(" ,.;:-")
    parts = [p.strip(" ,.;") for p in re.split(r"\s+or\s+|,\s*or\s+", text) if p.strip(" ,.;")]
    return parts


def add(variants, model, count, engines, doc, line):
    model = re.sub(r"\s+", " ", model).strip()
    entry = variants.setdefault(model, {"model": model, "engineCount": count, "engines": [], "source": []})
    for e in engines:
        if e not in entry["engines"]:
            entry["engines"].append(e)
    ref = {"name": DOC_NAMES[doc], "url": None, "line": line + 1}
    if not any(s["name"] == ref["name"] for s in entry["source"]):
        entry["source"].append(ref)


def parse_inline(lines, doc, variants):
    """'A330-243: Two (2) Rolls Royce Trent 772B-60 turbofan engines' (possibly over 2 lines)."""
    pattern = re.compile(rf"(?:Model\s+)?{MODEL}\s*:\s*({COUNT})\s+(.*)", re.I)
    for i, line in enumerate(lines):
        m = pattern.search(line)
        if not m:
            continue
        text = m.group(3)
        j = i
        # Keep reading continuation lines until we reach the word "engine(s)".
        while not re.search(r"engines?\b|Turbo Fan", text, re.I) and j + 1 < len(lines) and j - i < 3:
            j += 1
            text += " " + lines[j].strip()
        count = WORDS.get(m.group(2).split()[0].lower())
        engines = clean_engine_text(text)
        if engines:
            add(variants, m.group(1), count, engines, doc, i)


def parse_uk_a320(lines, doc, variants):
    """UK CAA A320 family: model alone on a line, then 'Two CFMI  CFM 56-5B4 jet engines (MOD ..), or'."""
    in_engines = False
    models = []
    for i, line in enumerate(lines):
        if re.match(r"^\d+\.\s+Engines\s*$", line.strip()):
            in_engines = True
            continue
        if in_engines and re.match(r"^\d+\.\s+\S", line.strip()):  # next numbered section
            in_engines, models = False, []
            continue
        if not in_engines:
            continue
        # A header can name several models: "A321-271N/A321-271NX"
        m = re.match(rf"^\s*({MODEL[1:-1]}(?:\s*/\s*{MODEL[1:-1]})*)\s*$", line)
        if m:
            models = [x.strip() for x in m.group(1).split("/")]
            continue
        m = re.match(r"^\s*(Two|Four)\s+(CFMI|IAE|PW|P&W|CFM)\s+(.*)$", line)
        if models and m:
            text = m.group(3)
            if re.match(r"\d", text):  # "Two PW 6122A jet engines": keep the "PW" that belongs to the name
                text = "PW " + text
            for model in models:
                add(variants, model, WORDS[m.group(1).lower()], clean_engine_text(text), doc, i)
            continue
        m = re.match(r"^\s{15,}((?:CFM ?56|V25|PW|LEAP)\S.*)$", line)  # 'or' continuation line
        if models and m:
            for model in models:
                add(variants, model, None, clean_engine_text(m.group(1)), doc, i)
            continue
        if line.strip():  # anything else (e.g. "ACJ320 NEO", "Notes:") ends the current model
            models = []


def parse_a220(lines, doc, variants):
    """EASA A220: 'SECTION n: MODEL BD-500-1A10' then '5. Engines' then 'Two (2) Pratt & Whitney PW1524G'."""
    model = None
    for i, line in enumerate(lines):
        m = re.search(r"SECTION \d+: MODEL (BD-500-1A1\d)\b", line)
        if m:
            model = m.group(1)
        m = re.match(r"^\s*Two \(2\) (Pratt & Whitney PW15\d\dG\S*)", line)
        if model and m:
            add(variants, model, 2, [m.group(1)], doc, i)


def main(folder):
    folder = Path(folder)
    urls = dict(line.split(maxsplit=1) for line in (folder / "SOURCES.txt").read_text().splitlines() if line.strip())
    variants = {}
    for doc in DOC_NAMES:
        path = folder / f"{doc}.txt"
        if not path.exists():
            print(f"missing {path}")
            continue
        lines = path.read_text(errors="replace").splitlines()
        if doc == "ukcaa-A320-family":
            parse_uk_a320(lines, doc, variants)
        elif doc == "easa-IMA570-A220":
            parse_a220(lines, doc, variants)
        else:
            parse_inline(lines, doc, variants)
        for v in variants.values():
            for s in v["source"]:
                if s["name"] == DOC_NAMES[doc]:
                    s["url"] = urls.get(doc, "").strip()

    # Models missing from the documents we can parse, added by hand from a search-result excerpt
    # of an official document. Marked so the page can say so.
    for extra in SUPPLEMENTS:
        variants.setdefault(extra["model"], extra)

    rows = sorted(variants.values(), key=lambda v: v["model"])
    doc = {
        "_about": "Exact aircraft model designation -> engines certified for that model, copied from official "
                  "type certificate data sheets (TCDS). Built by scripts/parse_tcds.py. 'line' is the line in the "
                  "text version of the TCDS (tcds-text branch). A model can list several engines (e.g. thrust "
                  "variants or modifications); the database cannot say which one a specific airframe has.",
        "variants": rows,
    }
    OUT.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(rows)} models -> {OUT}")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/tcds")
