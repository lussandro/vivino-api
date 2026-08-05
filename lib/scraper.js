import puppeteer from 'puppeteer';

export const BASE_URL = 'https://www.vivino.com';
export const SEARCH_PATH = '/search/wines?q=';
export const UA =
	'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
export const NAV_TIMEOUT_MS = 45_000;
export const CARD_WAIT_MS = 12_000;

export const launchBrowser = () =>
	puppeteer.launch({
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
	});

export const preparePage = async (browser) => {
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

export const collectItemsFn = () => {
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

export const setShipToFn = async (page, cc, sc) =>
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

export const parseRetryAfter = (headers) => {
	const ra = headers?.['retry-after'];
	if (!ra) return undefined;
	const n = Number(ra);
	if (!isNaN(n)) return n * 1000;
	const d = Date.parse(ra);
	if (!isNaN(d)) return Math.max(0, d - Date.now());
	return undefined;
};

export const fetchPage = async (browser, name, index, opts = {}) => {
	const {
		maxRetries = 5,
		baseDelay = 1000,
		maxDelay = 30_000,
		onRetry = () => {},
	} = opts;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const page = await preparePage(browser);
		try {
			const r = await page.goto(
				`${BASE_URL}${SEARCH_PATH}${encodeURIComponent(name)}&start=${index}`,
				{ waitUntil: 'domcontentloaded' },
			);
			const status = r.status();
			if (status === 429) {
				if (attempt === maxRetries) return { status, items: [], retry: true };
				const ra = parseRetryAfter(r.headers()) ?? Math.min(maxDelay, baseDelay * 2 ** attempt);
				onRetry({ index, attempt: attempt + 1, delay: ra });
				await page.close().catch(() => {});
				await new Promise((res) => setTimeout(res, ra));
				continue;
			}
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
	}
	return { status: 429, items: [], retry: true };
};

export const dedupeByVintage = (vinos) => {
	const key = (v) => {
		if (!v.link) return `${v.winery || ''}|${v.name || ''}`;
		try {
			const u = new URL(v.link);
			return `${u.pathname}|${u.searchParams.get('year') || ''}`;
		} catch (_) {
			return v.link;
		}
	};
	const seen = new Set();
	return vinos.filter((v) => {
		const k = key(v);
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
};

export const filterVinos = (vinos, f) =>
	vinos.filter((e) => {
		const hasPriceFilter = Boolean(f.minPrice) || Boolean(f.maxPrice);
		const hasPrice = e.price !== undefined && e.price !== null;
		if (hasPriceFilter && !hasPrice) {
			// When a price range is requested, items without a price are excluded
			// unless the caller opts in via noPriceIncluded (see README).
			if (!f.noPriceIncluded) return false;
		} else {
			if (f.minPrice && e.price < f.minPrice) return false;
			if (f.maxPrice && e.price > f.maxPrice) return false;
		}
		if (f.minRatings && e.ratings < f.minRatings) return false;
		if (f.maxRatings && e.ratings > f.maxRatings) return false;
		if (f.minAverage && e.average_rating < f.minAverage) return false;
		if (f.maxAverage && e.average_rating > f.maxAverage) return false;
		return true;
	});

export const runWithLimit = async (tasks, limit) => {
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

export const scrape = async (browser, params, opts = {}) => {
	const { concurrency = 3, log = () => {} } = opts;
	const wantShipTo = Boolean(params.country || params.state);
	const result = { vinos: [] };

	if (wantShipTo) {
		const setupPage = await preparePage(browser);
		try {
			await setupPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
			const cc = params.country || 'US';
			let sc = params.state || '';
			if (cc.toLowerCase() === 'us' && sc === '') sc = 'CA';
			await setShipToFn(setupPage, cc, sc).catch(() => {});
		} finally {
			await setupPage.close().catch(() => {});
		}
	}

	const maxPages = Math.max(1, Number(params.maxPages) || 3);
	const tasks = Array.from({ length: maxPages }, (_, i) => () =>
		fetchPage(browser, params.name, i + 1, {
			onRetry: ({ index, attempt, delay }) =>
				log(`429 page ${index}, retry ${attempt} in ${delay}ms`),
		}),
	);
	const pageResults = await runWithLimit(tasks, concurrency);

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
	if (!stopReason) stopReason = 'PAGE_LIMIT';
	result.status = stopReason;

	const before = result.vinos.length;
	result.vinos = dedupeByVintage(result.vinos);
	result.deduped = before - result.vinos.length;

	result.vinos = filterVinos(result.vinos, params);
	return result;
};
