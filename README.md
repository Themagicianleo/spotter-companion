# ✈ Spotter's Companion

A personal, non-commercial portfolio project: a live map of nearby aircraft built only on
free, open data. It gives you some features that paid flight trackers charge for:

- **Live map** (Phase 1): aircraft around a point (default: Singapore, 1.35, 103.82), with plane icons
  rotated to their direction of travel. Click a plane for callsign, registration, type, altitude,
  speed, vertical speed and squawk.
- **Filters, list and CSV** (Phase 2): filter by type codes, altitude range, or callsign/airline prefix.
  A sortable list sits next to the map, and you can export the current view as CSV.
- **Type and engine table** (Phase 3): 58 Boeing and Airbus airliner types in `data/aircraft_types.json`,
  each with its engine options and sources.
- **Aircraft info panel** (Phase 4): a photo from Planespotters.net (credited to its photographer), registration, model, manufacturer, year built, age, operator and
  engine options. Every value is tagged with where it came from (LIVE / DB / TYPE / CALC), and
  missing values show "Unknown".

## Screenshots

> These were taken by the automated tests with **synthetic test data**: made-up positions and
> `TEST-` registrations. Map tiles were blocked in the build environment, so the background is
> grey. Replace them with real screenshots once you run the app yourself.

| Map, list and filters | Aircraft info panel |
|---|---|
| ![Map and list (synthetic data)](docs/screenshots/synthetic-test-data.png) | ![Info panel (synthetic data)](docs/screenshots/info-panel-synthetic.png) |

## How to run it

You need Python 3, which most computers have. Nothing to install.

```bash
cd spotters-companion
python3 scripts/dev_server.py
# then open http://localhost:8000
```

`dev_server.py` serves the files and also **relays** the API requests (see "CORS" below), so the
app works on your computer even if the provider blocks direct browser requests.
Opening `index.html` by double-clicking it won't work: browsers block JavaScript modules on `file://` pages.

### Put it on GitHub Pages

Push the repo to GitHub, then go to **Settings → Pages → Deploy from branch → main / root**.
There's no build step.

**CORS:** a third-party page says adsb.lol doesn't send the `Access-Control-Allow-Origin`
header, which would stop a page on another site from reading its data. So the public site calls
adsb.lol through a small relay: the Cloudflare Worker in [`proxy/`](proxy/README.md), set as
`publicProxyBase` in `js/config.js`. If you fork this project, deploy your own relay and change
both `publicProxyBase` and `ALLOWED_ORIGIN`.

### Tests

```bash
npm test             # unit tests: API parsing, filters, sorting, CSV, type table rules (no install needed)
npm run test:e2e     # browser tests (needs Playwright: npm install --no-save playwright)
```

### Settings

Everything adjustable is in [`js/config.js`](js/config.js): default center, radius, polling interval
(10 s), the 1-request-per-second floor, cache time, and which provider to use.

### Update the aircraft database

```bash
python3 scripts/build_aircraft_db.py
```
This downloads the latest tar1090-db and rebuilds `data/aircraft_db/` with only the types in the type table.

## How it's organised

```
index.html, css/style.css
js/config.js       all settings
js/api.js          the ONLY file that talks to live-data providers (switch providers here)
js/app.js          polling loop, back-off after errors, error banner, center/radius controls
js/map.js          Leaflet map and rotating plane markers
js/filters.js      filter + sort logic (pure functions)
js/list.js         the sortable table
js/csv.js          CSV export
js/aircraftDb.js   cached lookups in data/aircraft_db/ and data/aircraft_types.json
js/infoPanel.js    the aircraft info panel
js/format.js       turns values into text, with "Unknown" for anything missing
js/main.js         wires everything together
data/aircraft_types.json   type + engine table (Phase 3)
data/aircraft_db/          airliner-only extract of tar1090-db (Phase 4)
scripts/dev_server.py      local server + relay
scripts/build_aircraft_db.py
proxy/                     optional relay for GitHub Pages
vendor/leaflet/            Leaflet 1.9.4 (copied in so the site needs no CDN)
tests/                     unit + browser tests (the fixture is synthetic, and labelled so)
```

**Dependencies:** just **Leaflet 1.9.4** (BSD-2-Clause), the map library, vendored in
`vendor/leaflet/`. Python 3 (standard library only) is used for the dev server and the database
build script. Playwright is only needed if you want to run the browser tests.

## Data sources, terms and attribution

I researched these on 21 Oct 2026. The build environment couldn't open most provider websites
directly, so some terms come from search-result summaries. **Re-read the providers' own terms
before you publish.**

| Source | Used for | Key? | Rate limit | Terms | Attribution |
|---|---|---|---|---|---|
| [adsb.lol](https://adsb.lol) `api.adsb.lol/v2/point` (default) | Live positions | No (a feeder-earned key is "planned") | "Dynamic based on load". The app polls every 10 s, never faster than 1/s, and backs off on 429 | Data under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The docs mark the open API "deprecated" in favour of a feeders-only API; the public endpoint still worked in Oct 2026 reports | Shown on the map, in the footer and in CSV exports |
| [airplanes.live](https://airplanes.live) (optional, in `api.js`) | Live positions | No | 1 request/s | Non-commercial. ⚠ An Oct 2026 report says feeders-only since Aug 2026 | Shown when selected |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles | Map background | No | [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/) | ODbL | "© OpenStreetMap contributors" |
| [tar1090-db](https://github.com/wiedehopf/tar1090-db) (from the [Mictronics](https://www.mictronics.de/aircraft-database/) database) | Registration, type, year, operator | No | Static file | ⚠ **No license file found**; terms unclear (see Limitations) | Shown in the info panel |
| [Planespotters.net](https://www.planespotters.net) photo API `api.planespotters.net/pub/photos/hex/{hex}` | Aircraft photo in the info panel | No | Not published. One lookup per aircraft per visit, cached in memory | [Terms of use](https://www.planespotters.net/legal/termsofuse): photos belong to the photographers; must show "© photographer" and link to the photo page; hotlink only, never re-host | "© name · via Planespotters.net" under each photo, and the photo links to its page |
| `data/aircraft_types.json` (my own table) | Model names, engine options | – | – | Built from EASA/FAA type certificate data sheets, regulator notices and manufacturer pages, each cited per row | Sources listed in the panel |

**Not used:**
- **OpenSky Network** for live data. Its terms require a written agreement for "operational" use
  in a live product. Accounts need OAuth2 secrets, which a static site can't hide. Anonymous use is
  400 credits/day, about an hour of 10-second polling. (Citation, if you use OpenSky data elsewhere:
  M. Schäfer et al., "Bringing Up OpenSky: A Large-scale ADS-B Sensor Network for Research", IPSN 2014.)
- **The OpenSky aircraft database** would add serial numbers, but I couldn't download it to check its real fields.
- **Flightradar24** or any other site whose terms forbid scraping.

**No secrets:** none of the providers used need a key. `.env` is in `.gitignore` in case one is ever added.
Remember that a static site can't keep any key secret.

## Limitations (please read)

- **The response format was first worked out from source code, then confirmed live.** The build
  environment couldn't reach any provider, so the format came from the source code of adsb.lol's
  API and readsb. A real response fetched through the relay on 21 Oct 2026 (14 aircraft near
  Singapore) matched it: `{"ac": [...], "msg": "No error", "now", "total", "ctime", "ptime"}`.
  It also showed `calc_track`, which is now used as a fallback direction. The automated tests
  still use a synthetic fixture.
- **The public site goes through a relay.** It calls adsb.lol through a Cloudflare Worker
  (`publicProxyBase` in `js/config.js`, code in `proxy/`), in case adsb.lol doesn't allow
  direct browser requests (CORS). Whether direct calls would work was never tested.
- **airplanes.live may now be feeders-only**, and its response format wasn't verified. The app shows
  an error rather than guessing if the format differs.
- **Age will often be "Unknown".** In tar1090-db, none of the 299 Singapore-registered (9V-)
  aircraft have a year or operator, and only about 20% of airliners overall have a year.
- **No serial numbers.** tar1090-db has no serial-number field.
- **Database licence is unclear.** tar1090-db has no licence file, and I couldn't find the Mictronics
  database terms. The repo includes an airliner-only extract (36,306 aircraft). If you're unsure,
  delete `data/aircraft_db/` and the panel will still work using the live feed's own
  registration/type fields.
- **Engine data was verified through search-result excerpts**, not by reading each TCDS PDF.
  These options are marked `verified: false` and shown as "unconfirmed" in the panel. Check them:
  - A19N: PW1100G-JM · A30B: JT9D-59A · A306: JT9D-7R4 · A310: JT9D-7R4, CF6-80A
  - B74S: all (JT9D, RB211-524) · B762: JT9D-7R4 · B763: PW4000 · B764: all (CF6-80C2, PW4000)
  - B77L: GE90-115B · B773: GE90 · B778/B779: GE9X · B788/B789: GEnx-1B
- **ICAO codes:** all 53 codes in the original list exist in tar1090-db with the expected names.
  Added: B732, A30B, B74S, B778, B779. I couldn't open ICAO Doc 8643 itself, so I checked against an
  FAA order that reproduces it, plus search results.
- **Photos:** I couldn't open Planespotters' API page from the build environment, so the response
  fields come from two open-source projects' parsers. Photos are matched by hex code and may show an
  older livery. The app asks Planespotters directly first and falls back to the relay, which sends a
  User-Agent with this repo's URL as contact information.
- **Engine options are per type, never per aircraft.** The app never claims which engine a specific airframe has.
- **Simplifications:** positions refresh every 10 s, so markers jump instead of gliding.
  Aircraft without a position are listed but not drawn. Polling pauses while the tab is hidden.
- **Not for navigation or safety use.** Data is crowd-sourced and can be missing, late or wrong.

## How AI was used

This project was built with an AI coding assistant (Claude, by Anthropic). I set the goals, the
hard rules (open data only, no invented fields, cite every source) and the phases.

The assistant:
- researched provider terms and documentation
- read the adsb.lol and readsb source code to find the real response format
- inspected the real tar1090-db file
- researched engine data
- wrote the code, comments and tests

The assistant also flagged what it could *not* verify. Those items are listed under Limitations
above and marked in the data. I'm responsible for checking those items and for reviewing the code.
