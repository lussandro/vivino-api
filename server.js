import express from 'express';
import compression from 'compression';
import { launchBrowser, scrape } from './lib/scraper.js';
import { createCache } from './lib/cache.js';

const PORT = process.env.PORT || 2010;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 60_000;
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY) || 3;

const cache = await createCache({
	ttlMs: CACHE_TTL_MS,
	redisUrl: process.env.REDIS_URL,
});

let browserPromise = null;
const getBrowser = async () => {
	if (browserPromise) {
		try {
			const b = await browserPromise;
			if (b.isConnected()) return b;
		} catch (_) {
			/* fall through */
		}
	}
	browserPromise = launchBrowser().then((b) => {
		b.on('disconnected', () => {
			browserPromise = null;
		});
		return b;
	});
	return browserPromise;
};

const toNum = (v) => (v === undefined ? undefined : Number(v));

const app = express();
app.use(compression());

app.get('/health', async (_req, res) => {
	res.json({ ok: true, cache: await cache.stats() });
});

app.get('/search', async (req, res) => {
	const { name } = req.query;
	if (!name) return res.status(400).json({ error: 'name required' });

	const params = {
		name,
		country: req.query.country,
		state: req.query.state,
		minPrice: toNum(req.query.minPrice),
		maxPrice: toNum(req.query.maxPrice),
		noPriceIncluded: req.query.noPriceIncluded === 'true',
		minRatings: toNum(req.query.minRatings),
		maxRatings: toNum(req.query.maxRatings),
		minAverage: toNum(req.query.minAverage),
		maxAverage: toNum(req.query.maxAverage),
		maxPages: toNum(req.query.maxPages),
	};
	const cacheKey = JSON.stringify(params);
	const cached = await cache.get(cacheKey);
	if (cached) {
		res.set('x-cache', 'HIT');
		return res.json(cached);
	}

	const t0 = Date.now();
	try {
		const browser = await getBrowser();
		const data = await scrape(browser, params, {
			concurrency: PAGE_CONCURRENCY,
			log: (msg) => console.log(`[${name}]`, msg),
		});
		data.elapsed_ms = Date.now() - t0;
		await cache.set(cacheKey, data);
		res.set('x-cache', 'MISS');
		res.json(data);
	} catch (err) {
		res.status(500).json({ error: String(err), elapsed_ms: Date.now() - t0 });
	}
});

const server = app.listen(PORT, '0.0.0.0', () => {
	console.log(
		`vivino-api listening on :${PORT} (cache=${cache.backend} ttl=${CACHE_TTL_MS}ms concurrency=${PAGE_CONCURRENCY})`,
	);
});

const shutdown = async () => {
	console.log('shutting down...');
	server.close();
	await cache.close().catch(() => {});
	if (browserPromise) {
		const b = await browserPromise.catch(() => null);
		if (b) await b.close().catch(() => {});
	}
	process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
