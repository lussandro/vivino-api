# Vivino API

HTTP wrapper + scraper for [vivino.com](https://www.vivino.com) wine search.

Fork of [aptash/vivino-api](https://github.com/aptash/vivino-api) with updated DOM selectors (2026), Puppeteer 22, Node 18, Docker image, and an Express server exposing the scraper as a REST endpoint.

## Why this fork

Upstream stopped in 2020. Vivino refactored its DOM since then — the original `.card.card-lg` / `.wine-card__name` selectors no longer match anything, so the original CLI silently returned `{vinos: []}`. This fork:

- Rewrites `collectItems()` against the current Vivino DOM using stable `data-testid` attributes and class-prefix matchers.
- Drops the `window.__PRELOADED_COUNTRY_CODE__` ship-to confirmation flow (those globals were removed). `setShipTo` is best-effort only.
- Bumps Puppeteer 5.5 → 22 (the old version cannot download Chromium anymore).
- Ships a Dockerfile so you do not need to install Chrome/Chromium locally.
- Adds an Express server on port `2010` exposing `/search` and `/health`.

## Quick start (Docker)

```bash
docker build -t vivino-api .
docker run -d --name vivino-api -p 2010:2010 vivino-api
curl "http://localhost:2010/health"
curl "http://localhost:2010/search?name=malbec&minPrice=15&maxPrice=25&minRatings=500&maxPages=2"
```

## HTTP API

### `GET /health`

Returns `{"ok": true}`.

### `GET /search`

| Param | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | string | **required** | Wine search query |
| `country` | string | `US` | Two-letter country code for "ship to" |
| `state` | string | `CA` (when `country=US`) | US state code |
| `minPrice` | number | — | Minimum price (in ship-to currency) |
| `maxPrice` | number | — | Maximum price |
| `noPriceIncluded` | `true`/`false` | `false` | Include items without a price |
| `minRatings` | number | — | Minimum number of ratings |
| `maxRatings` | number | — | Maximum number of ratings |
| `minAverage` | number | — | Minimum average rating (0–5) |
| `maxAverage` | number | — | Maximum average rating |
| `maxPages` | number | `3` | Cap on result pages (≈10 wines each) |

Response:

```json
{
  "vinos": [
    {
      "name": "D.V. Catena Malbec - Malbec 2022",
      "winery": "Catena",
      "link": "https://www.vivino.com/en/catena-d-v-catena-malbec-malbec/w/68874?year=2022&price_id=39813797",
      "thumb": "https://images.vivino.com/thumbs/F_Qx7EnDRN-yHzCbyBhPFg_pb_x300.png",
      "country": "Argentina",
      "country_code": "AR",
      "region": "Mendoza",
      "average_rating": 4.3,
      "ratings": 1882,
      "price": 307.69,
      "currency": "R$"
    }
  ],
  "status": "FULL_DATA"
}
```

Possible `status` values: `FULL_DATA`, `PAGE_LIMIT`, `RESPONSE_ERROR`, `SHIP_TO_ERROR`, `SHIP_TO_CONFIRM_ERROR`, `SOME_EXCEPTION`.

## Legacy CLI

The original `vivino.js` script is still in the repo and still writes `vivino-out.json`:

```bash
node vivino.js --name=malbec --minPrice=10 --maxPrice=25
node vivino.js "--name=Pinot Noir" --country=US --state=NY
```

Note: the CLI uses the *old* `collectItems()`. Only `server.js` has the updated selectors. PRs welcome to backport.

## Local development (no Docker)

```bash
npm install
node server.js          # server on :2010
node vivino.js --name=malbec   # CLI (legacy selectors)
```

Requires Node 18+. Puppeteer will download a matching Chromium on first install.

## Performance

Measured on this fork (warm Docker, default `PAGE_CONCURRENCY=3`):

| Scenario | Time | Items |
| --- | --- | --- |
| Cold start (first request after server boot) | ~2.7s | 24 |
| Warm single page | ~3s | 24 |
| Warm 3 pages (parallel) | ~7s | 72 |
| Cache hit (same query within 60s) | ~10ms | — |

Tuning knobs (env vars):

- `PAGE_CONCURRENCY` (default `3`) — parallel page fetches. Raise carefully; Vivino sends 429 if pushed.
- `CACHE_TTL_MS` (default `60000`) — in-memory cache TTL per query.

Architecture choices that made it fast:

- **Persistent browser** — one `puppeteer.launch` shared across all `/search` requests (auto-relaunch on disconnect). Cold Chromium boot only happens once per server lifetime.
- **`domcontentloaded` + `waitForSelector`** instead of `networkidle2` — does not block on analytics/tracking XHRs.
- **Skip BASE_URL warmup** — only visit `vivino.com/` and call `setShipTo` when the request includes `country`/`state`.
- **Parallel pagination** — pages 1..N fetched concurrently (capped by `PAGE_CONCURRENCY`) and merged in order.
- **TTL cache + gzip** — instant repeats and smaller payloads.
- **Aggressive request blocking** — only `document`, `xhr`, `fetch`, `script` reach the network. Images, stylesheets, fonts, media all aborted.

## Notes & caveats

- Vivino is a JS-rendered SPA and actively rate-limits scrapers. Expect 429s for bursty traffic; the server backs off (15s × attempt).
- The `country`/`state` (`ship_to`) endpoint sets browser-cookie state on Vivino but the post-set confirmation check from the original code no longer works. Treat it as best-effort.
- Selectors will rot again. If `/search` starts returning `{vinos: []}` with `status: FULL_DATA`, re-run `probe.mjs` against a live page to discover new attributes.

## License

[MIT](LICENSE)

## Contributing

Issues and PRs welcome — this is an actively maintained fork. Open a PR against `main`.
