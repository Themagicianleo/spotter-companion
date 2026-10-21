# Optional relay (only if the live map shows a "CORS" error on GitHub Pages)

## Why this exists

Browsers protect you by refusing to let a web page read data from another website unless
that website says it's OK, using a `Access-Control-Allow-Origin` header ("CORS").
A third-party page says adsb.lol does **not** send that header. I could not test it from
my build environment, so this is unconfirmed. If it's true, the GitHub Pages version can't
read the data directly, and you'll see the "Could not reach adsb.lol … (CORS)" message.

Running locally with `python3 scripts/dev_server.py` avoids this, because that server
fetches the data for the page.

## Fix for the public site: a tiny relay

`cloudflare-worker.js` is about 30 lines. Cloudflare Workers has a free plan.

1. Make a free Cloudflare account, go to **Workers & Pages → Create → Worker**.
2. Paste in `cloudflare-worker.js`, change `ALLOWED_ORIGIN` to your GitHub Pages address, deploy.
3. In `js/config.js`, set the relay URL for the public site, for example:
   `'https://spotters-relay.YOUR-NAME.workers.dev/?url='`

This *is* a small backend, which the original brief wanted to avoid. It's only needed if CORS
really is blocked. It holds no secrets, and it only relays to the two allowed provider hosts.
