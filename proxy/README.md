# The Cloudflare worker: relay + flight recorder

`cloudflare-worker.js` runs on Cloudflare's free plan as **spotters-relay**. It does two jobs:

1. **Relay** (`/?url=…`): fetches data for the website from adsb.lol, Planespotters and
   aviationweather.gov (METAR/TAF weather). Those
   services may not allow web pages on other sites to read their answers (CORS). It only relays
   to the hosts in `ALLOWED_HOSTS`, and only answers SkyWatch's own sites (`ALLOWED_ORIGINS`).
2. **Recorder**: once a minute, Cloudflare runs it automatically (a "Cron Trigger"). It asks
   adsb.lol once for all aircraft within 80 nm of Singapore and saves their positions in a D1
   database, keeping 24 hours. When you click a plane, the website asks `/track?hex=…` for its
   recent path, so the track no longer starts only when you open the page.
   - `/recorder-status` shows how many snapshots are stored and when the last one was taken.
   - `/stats?hours=24` sums up the stored snapshots for the Stats panel: aircraft per hour and the top
     types and airlines. The database does the counting; the answer is reused for 5 minutes.

Free-plan budget (checked Oct 2026): D1 allows 100,000 row writes and 5 million row reads per
day, and 5 GB of storage. The recorder writes about 2,900 rows a day (one snapshot plus one
cleanup per minute) and stores roughly 4 MB. It sends adsb.lol one request a minute.

## Setup (one time)

1. **Create the database.** In the Cloudflare dashboard: **Storage & databases → D1 SQL database →
   Create** and name it `spotters-tracks`. The worker creates its own table, so there's nothing to type in.
2. **Connect it to the worker.** Open **Workers & Pages → spotters-relay → Settings → Bindings →
   Add → D1 database**. Set the variable name to exactly `DB`, choose `spotters-tracks`, and save.
3. **Make it run every minute.** In the same **Settings**, under **Trigger events** (or **Triggers**),
   click **Add → Cron Triggers** and enter `* * * * *` ("every minute"), then save.
4. **Update the code.** Click **Edit code**, replace everything with `cloudflare-worker.js`, and **Deploy**.
5. **Check it.** After 2–3 minutes, open `https://spotters-relay.<your-name>.workers.dev/recorder-status`.
   You should see `"snapshots"` counting up and `"aircraftInLatest"` above 0.

If you fork this project: change `ALLOWED_ORIGIN` here, and `publicProxyBase` and
`recorderBase` in `js/config.js`, to your own addresses.

## Updating the worker (do this after pulling new code)

When `cloudflare-worker.js` changes, Cloudflare keeps running the old copy until you paste the new one:
**Workers & Pages → spotters-relay → Edit code**, select everything, paste the new file, **Deploy**.
The bindings and Cron Trigger stay as they are.

The Oct 2026 update (Weather + Stats) needs this: it adds `aviationweather.gov` to the relay, records each
aircraft's callsign and type, and adds `/stats`. Check afterwards:
- `https://spotters-relay.<your-name>.workers.dev/stats` answers with JSON (types fill in over the next hour), and
- the Weather button on the site changes from "Weather" to something like `WSSS 28° 4 kt`.

Storage after the update: each snapshot also holds callsigns and types, roughly doubling it to about 8 MB
for 24 hours, still far below the free 5 GB.

## Second address (Cloudflare Pages)

SkyWatch is also published at its own address on Cloudflare Pages (so Safari's Favorites shows its own icon instead
of the one for the shared github.io address). The worker accepts both `https://themagicianleo.github.io` and
`https://skywatch.pages.dev` (`ALLOWED_ORIGINS`). If Cloudflare gives the project a different address, add it without
editing code: **Workers & Pages → spotters-relay → Settings → Variables and Secrets → Add**, name `EXTRA_ORIGINS`,
value e.g. `https://skywatch-abc.pages.dev` (several addresses: separate with commas), then **Deploy**.

## Data licence

The recorded positions come from adsb.lol, whose data is under the
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). If you ever publish the stored data
itself (not just maps made from it), it has to stay under ODbL and credit adsb.lol.
