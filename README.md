# ✈ Spotter's Companion

A personal, non-commercial hobby project by an aviation enthusiast: a live map of nearby aircraft built only on
free, open data. It gives you some features that paid flight trackers charge for:

- **Live map** (Phase 1): aircraft around a point (default: Singapore, 1.35, 103.82), with plane icons
  rotated to their direction of travel. Click a plane for callsign, registration, type, altitude,
  speed, vertical speed and squawk.
- **Distance and times:** the flight card shows the route's great-circle distance (e.g. LHR → SIN 5,877 nm /
  10,883 km); flights with a stop (e.g. QF1 SYD → SIN → LHR) list each leg separately plus the total, with
  the leg being flown marked. It also shows the distance still to fly, an **estimated** arrival time (distance to go ÷ current ground speed),
  and the departure time **only if the app saw the takeoff** (in a recorded or live track). There is no
  schedule data, so scheduled/actual gate times aren't available.
- **Flight routes:** origin, stops and destination for each callsign (e.g. CXA865 FOC → SIN) in the
  list, hover label, flight card and CSV. A "(?)" warns when the plane isn't near the route on record.
- **Dark, map-first interface** (inspired by flight-tracker apps like Plane Finder): full-screen map,
  yellow planes, a search box, and a flight card with a big route display, progress bar and live tiles.
  Works on phones too: the card becomes a bottom sheet.
- **Aircraft silhouettes and airline badges:** each plane is drawn as its kind of aircraft (narrowbody,
  widebody, four-engine, A380, trijet, turboprop, business jet, light plane, helicopter; original drawings in
  `js/shapes.js`), with its airline's code (e.g. SQ, TR, EK) in a small badge. The airline name also appears in
  the hover label and the flight card. Real airline logos aren't used: they're copyrighted trademarks with no
  open licence. Badges can be switched off in Filters.
- **Icons sized by aircraft class:** from the ADS-B emitter category each aircraft broadcasts (light,
  small, large, 757-class, heavy, helicopter); the A380 is biggest. No category = medium size.
- **Map styles (layers button):** **Dark** (default) and **Streets** are sharp vector maps from
  OpenFreeMap, drawn by MapLibre, so text and roads stay crisp at every zoom and on Retina screens.
  **Satellite** is Sentinel-2 imagery, and **Classic** is the plain OpenStreetMap image map. If a browser
  can't run MapLibre (no WebGL), the app falls back to Classic.
- **Flight tracks:** select a plane (on the map or in the list) to see where it has flown, coloured
  by altitude. Click empty map to hide it. A small recorder on Cloudflare keeps 24 hours of positions
  around Singapore, so tracks include where the plane was before you opened the page (see `proxy/README.md`).
- **Filters, list and CSV** (Phase 2): filter by type codes, altitude range, or callsign/airline prefix.
  A sortable list opens from the **List** button, filters from **Filters**, and you can export the current view as CSV.
- **Type and engine table** (Phase 3): 58 Boeing and Airbus airliner types in `data/aircraft_types.json`,
  each with its engine options and sources.
- **Aircraft info panel** (Phase 4): a photo from Planespotters.net (credited to its photographer), registration, type, exact model, manufacturer and
  engines. Every value is tagged with where it came from (LIVE / DB / OSN / VRS / TCDS / TYPE), and
  missing values show "Unknown".

## Screenshots

> These were taken by the automated tests with **synthetic test data**: made-up positions and
> `TEST-` registrations. Map tiles were blocked in the build environment, so the background is
> grey. Replace them with real screenshots once you run the app yourself.

| Map, list and filters | Aircraft info panel |
|---|---|
| ![Map and list (synthetic data)](docs/screenshots/synthetic-test-data.png) | ![Info panel (synthetic data)](docs/screenshots/info-panel-synthetic.png) |

## How to use it

- **Click a plane** (or a row in the list) to open its flight card; click empty map to close it and hide its track.
- **Hover** over a plane for a quick label: callsign, type, route, altitude.
- **Search** (top bar) matches callsign, registration, type code or airport code, e.g. `SIA`, `9V-`, `A359` or `SIN`.
- **List**, **Filters** and **Area** (top right) open the aircraft list, the filters and the search-area settings.

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
python3 scripts/build_aircraft_db.py   merges tar1090-db + OpenSky into data/aircraft_db/ (run monthly by GitHub Actions)
scripts/parse_tcds.py          builds data/aircraft_variants.json from the TCDS text
scripts/tcds_sources.txt       which TCDS documents to fetch
.github/workflows/             build-aircraft-db.yml (monthly DB rebuild), fetch-tcds.yml (TCDS PDFs -> text)
```
This downloads the latest tar1090-db and OpenSky aircraft database and rebuilds `data/aircraft_db/`
with only the types in the type table. GitHub Actions also does this automatically on the 2nd of
every month (`.github/workflows/build-aircraft-db.yml`). To rebuild the certified-engine table, see the
comment at the top of `scripts/parse_tcds.py`.

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
js/photos.js       aircraft photos from Planespotters.net
js/track.js        remembers positions so the map can draw tracks
js/routes.js       flight routes by callsign, with a plausibility check
js/airlines.js     airline name and code from the callsign
js/shapes.js       aircraft silhouettes for the map icons
js/format.js       turns values into text, with "Unknown" for anything missing
js/main.js         wires everything together
data/aircraft_types.json   type + engine table (Phase 3)
data/aircraft_variants.json exact model -> certified engines, parsed from official TCDS
data/routes.json           routes near Singapore (scripts/build_routes.py)
data/aircraft_db/          airliner-only extract of tar1090-db (Phase 4)
scripts/dev_server.py      local server + relay
scripts/build_aircraft_db.py
proxy/                     Cloudflare worker: relay + flight recorder (setup steps in proxy/README.md)
vendor/leaflet/            Leaflet 1.9.4 (copied in so the site needs no CDN)
tests/                     unit + browser tests (the fixture is synthetic, and labelled so)
```

**Dependencies** (all vendored in `vendor/`, so the site needs no CDN):
- **Leaflet 1.9.4** (BSD-2-Clause): the map library.
- **MapLibre GL 5.24.0** (BSD-3-Clause, about 280 KB compressed): draws the sharp vector maps.
- **@maplibre/maplibre-gl-leaflet 0.1.4** (ISC): lets Leaflet show a MapLibre map as a layer.
 Python 3 (standard library only) is used for the dev server and the database
build script. Playwright is only needed if you want to run the browser tests.

## Data sources, terms and attribution

I researched these on 21 Oct 2026. The build environment couldn't open most provider websites
directly, so some terms come from search-result summaries. **Re-read the providers' own terms
before you publish.**

| Source | Used for | Key? | Rate limit | Terms | Attribution |
|---|---|---|---|---|---|
| [adsb.lol](https://adsb.lol) `api.adsb.lol/v2/point` (default) | Live positions | No (a feeder-earned key is "planned") | "Dynamic based on load". The app polls every 10 s, never faster than 1/s, and backs off on 429 | Data under [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The docs mark the open API "deprecated" in favour of a feeders-only API; the public endpoint still worked in Oct 2026 reports | Shown on the map, in the footer and in CSV exports |
| [airplanes.live](https://airplanes.live) (optional, in `api.js`) | Live positions | No | 1 request/s | Non-commercial. ⚠ An Oct 2026 report says feeders-only since Aug 2026 | Shown when selected |
| [OpenFreeMap](https://openfreemap.org) vector maps ("dark", "liberty" styles) | Dark and Streets map backgrounds | No | No limits on the public instance | Free; map data © OpenStreetMap (ODbL), OpenMapTiles (BSD/CC BY 4.0), styles MIT/BSD/CC BY | "OpenFreeMap © OpenMapTiles Data from OpenStreetMap" on the map |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles | Map background | No | [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/) | ODbL | "© OpenStreetMap contributors" |
| [EOX Sentinel-2 cloudless 2024](https://s2maps.eu) tiles | Satellite background (Map/Satellite switch) | No | Not published | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/): free for non-commercial use with attribution; commercial use needs an EOX licence | "Sentinel-2 cloudless by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024)" shown on the map |
| [tar1090-db](https://github.com/wiedehopf/tar1090-db) (from the [Mictronics](https://www.mictronics.de/aircraft-database/) database) | Registration, type, year, operator | No | Static file | ⚠ **No license file found**; terms unclear (see Limitations) | Shown in the info panel |
| [Planespotters.net](https://www.planespotters.net) photo API `api.planespotters.net/pub/photos/hex/{hex}` | Aircraft photo in the info panel | No | Not published. One lookup per aircraft per visit, cached in memory | [Terms of use](https://www.planespotters.net/legal/termsofuse): photos belong to the photographers; must show "© photographer" and link to the photo page; hotlink only, never re-host | "© name · via Planespotters.net" under each photo, and the photo links to its page |
| [OpenSky Network aircraft database](https://opensky-network.org/data/aircraft) (monthly snapshot, merged by the build) | Exact model (e.g. A320-251N), serial number, build year, engine as recorded | No | Static file | OpenSky says the aircraft database is not covered by its terms of use (search summary; page not reachable from the build environment) | "OSN" tag on each value |
| Official type certificate data sheets (EASA, UK CAA), as text on the `tcds-text` branch | `data/aircraft_variants.json`: engines certified for each exact Airbus/A220 model | No | – | Public regulatory documents | "TCDS" tag; document name and text line number shown in the panel |
| [Virtual Radar Server standing data](https://github.com/vradarserver/standing-data), aircraft files | Operator, serial number, year built, exact model (aircraft corrected by VRS users since 2022) | No | Static file (merged into `data/aircraft_db/` monthly) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | "VRS" tag on each value |
| [Virtual Radar Server standing data](https://github.com/vradarserver/standing-data) (routes + airports; also used by adsb.lol) | Flight routes: callsign → origin, stops, destination | No | Static file (`data/routes.json`, rebuilt monthly) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/): no restrictions | "ROUTE" tag in the panel (credited even though CC0 doesn't require it) |
| [Virtual Radar Server standing data](https://github.com/vradarserver/standing-data), airlines file | Airline name and IATA code from the callsign (`data/airlines.json`) | No | Static file (rebuilt monthly) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Credited with the routes |
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
- **Serial number, year built, age and operator are not shown.** The free databases had them for too few
  aircraft (e.g. 66 of 299 Singapore-registered aircraft had a build year), so they were removed from the
  card. Missing fields that remain are listed on one line. When sources disagree on the exact model
  (e.g. E195-E2 vs E190-E2), the card shows both.
- **Every Singapore-registered (9V-) aircraft is in the database**, whatever its type; other countries'
  aircraft only if they're one of the Boeing/Airbus types in the type table.
- **Exact model and certified engine are often missing.** These come from OpenSky's
  community database (August 2025 snapshot). For Airbus types, about 63% of aircraft get an exact
  certified engine. The table covers Airbus and A220 models (104 models from the official type
  certificates); Boeing model numbers are customer codes that don't identify the engine. When a model
  lists several engine versions (thrust ratings or modifications), the panel shows them all, because the
  database doesn't say which one an airframe has. For types with only one engine (e.g. 737 MAX 8, 777-300ER),
  the panel says that engine applies.
- **OpenSky model strings are tidied before matching.** Text in brackets and an "SL" suffix are removed,
  and one trailing E/X/F is dropped if needed (e.g. "A330-343E" is matched to the certified "A330-343").
  The panel always shows the original text.
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
- **Photos:** I couldn't open Planespotters' API documentation, so the response fields were first taken
  from two open-source projects' parsers. A real response through the relay (21 Oct 2026, 9V-SJA)
  then confirmed them. Photos are matched by hex code and may show an
  older livery. The app asks Planespotters directly first and falls back to the relay, which sends a
  User-Agent with this repo's URL as contact information.
- **Tracks are regional, not whole flights.** The recorder only covers 80 nm around Singapore, saves
  one position per minute (so older parts of a track are less detailed), and keeps 24 hours. The page
  shows up to 3 hours of it, and drops any part separated by more than 5 minutes (e.g. an earlier
  flight of the same aircraft). Without the recorder (or on localhost), tracks start when you open the page.
- **Satellite imagery is about 10 m per pixel** (Sentinel-2), so you'll see airports and runways but not
  individual aircraft. Sharper imagery (Esri, Google, Mapbox) needs an account or key, or doesn't
  allow this use. The EOX tile URL comes from third-party listings, so check that the Satellite
  view loads.
- **Routes are looked up by callsign** in a crowd-sourced database, which can be outdated or missing
  (airlines reuse flight numbers). Like adsb.lol, the app checks the route is plausible: the plane must be
  within 50 nm, or 20% of the leg length, of the straight line between airports. Otherwise it shows "(?)"
  and a warning. Only routes passing within 300 nm of Singapore are included (8,739 of ~620,000), and
  callsigns using IATA airline codes aren't converted to ICAO.
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
