// config.js
// Every setting you might want to change lives here, so you never have to hunt through the code.

export const CONFIG = {
  // Where the map starts. Singapore, roughly the middle of the island.
  defaultCenter: { lat: 1.35, lon: 103.82 },

  // How far around the center to ask for aircraft, in nautical miles (1 nm = 1.852 km).
  // The adsb.lol source code caps this at 250 nm.
  defaultRadiusNm: 40,

  // How often to ask the provider for fresh positions. 10 seconds is gentle on a
  // volunteer-run service and still feels "live" for spotting.
  pollIntervalMs: 10_000,

  // Hard floor between any two requests. Providers ask for at most 1 request per second.
  minRequestGapMs: 1_100,

  // If the same request was answered less than this long ago, reuse the cached answer.
  cacheTtlMs: 5_000,

  // After errors we wait longer and longer (doubling) but never more than this.
  maxBackoffMs: 120_000,

  // Give up on a request that takes longer than this.
  requestTimeoutMs: 15_000,

  // Which live-data provider to use. Must be a key of PROVIDERS in api.js.
  provider: 'adsbLol',

  // Relay for providers that block browser requests (CORS).
  // - On your own computer (localhost), scripts/dev_server.py provides one at /relay.
  // - On the public site, leave publicProxyBase empty to call the provider directly, or set it
  //   to your relay (see proxy/README.md), e.g. 'https://my-relay.example.workers.dev/?url='
  publicProxyBase: 'https://spotters-relay.maotianze.workers.dev/?url=',
  get proxyBase() {
    const host = globalThis.location?.hostname;
    return host === 'localhost' || host === '127.0.0.1' ? '/relay?url=' : this.publicProxyBase;
  },
};
