import express from 'express';
import compression from 'compression';
import puppeteer from 'puppeteer';

const PORT = process.env.PORT || 2010;
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 60_000;
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY) || 3;
const NAV_TIMEOUT_MS = 45_000;
const CARD_WAIT_MS = 12_000;
const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const BASE_URL = 'https://www.vivino.com';
const SEARCH_PATH = '/search/wines?q=';

const cache = new Map();
const getCache = (k) => {
	const e = cache.get(k);
	if (!e) return undefined;
	if (Date.now() - e.t > CACHE_TTL_MS) {
		cache.delete(k);
		return undefined;
	}
	return e.v;
};
const setCache = (k, v) => cache.set(k, { v, t: Date.now() });

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
	browserPromise = puppeteer
		.launch({
			headless: 'new',
			defaultViewport: { width: 1366, height: 900 },
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--disable-gpu',
				'--disable-extensions',
				'--no-first-run',
				'--no-zygote',
				'--disable-background-networking',
			],
		})
		.then((b) => {
			b.on('disconnected', () => {
				browserPromise = null;
			});
			return b;
		});
	return browserPromise;
};

const preparePage = async (browser) => {
	const page = await browser.newPage();
	await page.setUserAgent(UA);
	await page.setRequestInterception(true);
	page.on('request', (r) => {
		const t = r.resourceType();
		if (t === 'document' || t === 'xhr' || t === 'fetch' || t === 'script') r.continue();
		else r.abort();
	});
	page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
	return page;
};

const collectItemsFn = () => {
	const num = (s) => {
		if (!s) return undefined;
		const cleaned = s.replace(/[^0-9,.\-]/g, '');
		let n;
		if (cleaned.includes('.') && cleaned.includes(',')) {
			n = parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
		} else if (cleaned.includes(',')) {
			n = parseFloat(cleaned.replace(',', '.'));
		} else {
			n = parseFloat(cleaned);
		}
		return isNaN(n) ? undefined : n;
	};
	const intFrom = (s) => {
		if (!s) return undefined;
		const m = s.replace(/[^0-9]/g, '');
		return m ? parseInt(m, 10) : undefined;
	};
	return [...document.querySelectorAll('[data-testid="wineCard"]')].map((e) => {
		const linkEl = e.querySelector('a[data-testid="vintagePageLink"]');
		const link = linkEl
			? new URL(linkEl.getAttribute('href'), 'https://www.vivino.com').href
			: undefined;
		const nameNodes = e.querySelectorAll('[class*="wineInfoVintage"] [class*="truncate"]');
		const winery = nameNodes[0]?.textContent.trim();
		const fullName = nameNodes[1]?.textContent.trim() || winery;
		const regionCountry = e.querySelector('[class*="regionAndCountry"]')?.textContent.trim() || '';
		let region, country;
		if (regionCountry.includes(',')) {
			const parts = regionCountry.split(',').map((s) => s.trim());
			region = parts[0];
			country = parts[parts.length - 1];
		} else {
			country = regionCountry;
		}
		const flagEl = e.querySelector('[data-testid^="countryFlag-"]');
		const country_code = flagEl
			? flagEl.getAttribute('data-testid').replace('countryFlag-', '').toUpperCase()
			: undefined;
		const avg = num(e.querySelector('[class*="vivinoRating__averageValue"]')?.textContent);
		const ratings = intFrom(e.querySelector('[class*="vivinoRating__caption"]')?.textContent);
		const priceText =
			e.querySelector('[data-testid="addToCart"] [class*="addToCartButton__price"]')?.textContent ||
			e.querySelector('[class*="addToCartButton__price"]')?.textContent;
		const price = num(priceText);
		const currency = priceText ? (priceText.match(/[A-Z$€£R]+\$?/)?.[0] || '').trim() : undefined;
		let thumb;
		const bottle = e.querySelector('[class*="bottleShot__bottleShot"]');
		if (bottle) {
			const bg = bottle.style.backgroundImage || '';
			const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
			if (m) thumb = m[1].startsWith('//') ? 'https:' + m[1] : m[1];
		}
		if (!thumb) {
			const img = e.querySelector('img[data-testid="deferredHiddenImage"]');
			if (img) thumb = img.src.startsWith('//') ? 'https:' + img.src : img.src;
		}
		return {
			name: fullName,
			winery,
			link,
			thumb,
			country,
			country_code,
			region,
			average_rating: avg,
			ratings,
			price,
			currency,
		};
	});
};

const setShipToFn = async (page, cc, sc) =>
	page.evaluate(
		async (cc, sc) => {
			try {
				const res = await fetch('https://www.vivino.com/api/ship_to/', {
					headers: {
						'content-type': 'application/json',
						'x-csrf-token': document.querySelector('[name="csrf-token"]')?.content || '',
					},
					body: JSON.stringify({ country_code: cc, state_code: sc }),
					method: 'PUT',
				});
				return res.status === 200;
			} catch (_) {
				return false;
			}
		},
		cc,
		sc,
	);

const fetchPage = async (browser, name, index) => {
	const page = await preparePage(browser);
	try {
		const r = await page.goto(`${BASE_URL}${SEARCH_PATH}${encodeURIComponent(name)}&start=${index}`, {
			waitUntil: 'domcontentloaded',
		});
		const status = r.status();
		if (status === 429) return { status, items: [], retry: true };
		if (!r.ok()) return { status, items: [] };
		try {
			await page.waitForSelector('[data-testid="wineCard"]', { timeout: CARD_WAIT_MS });
		} catch (_) {
			return { status, items: [] };
		}
		const items = await page.evaluate(collectItemsFn);
		return { status, items };
	} finally {
		await page.close().catch(() => {});
	}
};

const runWithLimit = async (tasks, limit) => {
	const results = new Array(tasks.length);
	let i = 0;
	const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
		while (true) {
			const idx = i++;
			if (idx >= tasks.length) return;
			results[idx] = await tasks[idx]();
		}
	});
	await Promise.all(workers);
	return results;
};

const scrape = async (params) => {
	const {
		name,
		country,
		state,
		minPrice,
		maxPrice,
		noPriceIncluded,
		minRatings,
		maxRatings,
		minAverage,
		maxAverage,
	} = params;

	const wantShipTo = Boolean(country || state);
	const result = { vinos: [] };
	const browser = await getBrowser();

	if (wantShipTo) {
		const setupPage = await preparePage(browser);
		try {
			await setupPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
			const cc = country || 'US';
			let sc = state || '';
			if (cc.toLowerCase() === 'us' && sc === '') sc = 'CA';
			await setShipToFn(setupPage, cc, sc).catch(() => {});
		} finally {
			await setupPage.close().catch(() => {});
		}
	}

	const maxPages = Math.max(1, Number(params.maxPages) || 3);
	const tasks = [];
	for (let p = 1; p <= maxPages; p++) {
		tasks.push(() => fetchPage(browser, name, p));
	}

	const pageResults = await runWithLimit(tasks, PAGE_CONCURRENCY);

	let stopReason;
	for (let i = 0; i < pageResults.length; i++) {
		const r = pageResults[i];
		if (!r) continue;
		if (r.retry) {
			result.http_status = 429;
			result.page_index = i + 1;
			stopReason = 'RATE_LIMITED';
			break;
		}
		if (r.status && r.status >= 400) {
			result.http_status = r.status;
			result.page_index = i + 1;
			stopReason = 'RESPONSE_ERROR';
			break;
		}
		if (!r.items.length) {
			stopReason = 'FULL_DATA';
			break;
		}
		result.vinos.push(...r.items);
	}
	if (!stopReason) stopReason = result.vinos.length >= maxPages * 1 ? 'PAGE_LIMIT' : 'FULL_DATA';
	result.status = stopReason;

	const dedupKey = (v) => {
		if (!v.link) return `${v.winery || ''}|${v.name || ''}`;
		try {
			const u = new URL(v.link);
			const year = u.searchParams.get('year') || '';
			return `${u.pathname}|${year}`;
		} catch (_) {
			return v.link;
		}
	};
	const seen = new Set();
	const before = result.vinos.length;
	result.vinos = result.vinos.filter((v) => {
		const k = dedupKey(v);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	result.deduped = before - result.vinos.length;

	result.vinos = result.vinos.filter((e) => {
		if (minPrice && (e.price || !noPriceIncluded) && e.price < minPrice) return false;
		if (maxPrice && e.price > maxPrice) return false;
		if (minRatings && e.ratings < minRatings) return false;
		if (maxRatings && e.ratings > maxRatings) return false;
		if (minAverage && e.average_rating < minAverage) return false;
		if (maxAverage && e.average_rating > maxAverage) return false;
		return true;
	});

	return result;
};

const toNum = (v) => (v === undefined ? undefined : Number(v));

const app = express();
app.use(compression());

app.get('/health', (_req, res) => res.json({ ok: true, cached: cache.size }));

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
	const cached = getCache(cacheKey);
	if (cached) {
		res.set('x-cache', 'HIT');
		return res.json(cached);
	}

	const t0 = Date.now();
	try {
		const data = await scrape(params);
		data.elapsed_ms = Date.now() - t0;
		setCache(cacheKey, data);
		res.set('x-cache', 'MISS');
		res.json(data);
	} catch (err) {
		res.status(500).json({ error: String(err), elapsed_ms: Date.now() - t0 });
	}
});

const server = app.listen(PORT, '0.0.0.0', () => {
	console.log(`vivino-api listening on :${PORT} (cache ${CACHE_TTL_MS}ms, concurrency ${PAGE_CONCURRENCY})`);
});

const shutdown = async () => {
	console.log('shutting down...');
	server.close();
	if (browserPromise) {
		const b = await browserPromise.catch(() => null);
		if (b) await b.close().catch(() => {});
	}
	process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
