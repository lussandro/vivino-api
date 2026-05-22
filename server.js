import express from 'express';
import puppeteer from 'puppeteer';

const PORT = process.env.PORT || 2010;
const app = express();

const scrape = async (params) => {
	const {
		name,
		country = 'US',
		state: stateIn = '',
		minPrice,
		maxPrice,
		noPriceIncluded,
		minRatings,
		maxRatings,
		minAverage,
		maxAverage,
	} = params;

	let state = stateIn;
	if (country.toLowerCase() === 'us' && state === '') state = 'CA';

	const BASE_URL = 'https://www.vivino.com';
	const SEARCH_PATH = '/search/wines?q=';
	const PAUSE_MULTIPLIER = 15;
	const result = { vinos: [] };

	const browser = await puppeteer.launch({
		headless: 'new',
		defaultViewport: { width: 1920, height: 1040 },
		args: ['--no-sandbox', '--disable-setuid-sandbox'],
	});
	const page = await browser.newPage();
	await page.setUserAgent(
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
	);
	await page.setRequestInterception(true);
	page.on('request', (r) => {
		if (['document', 'xhr', 'fetch', 'script'].includes(r.resourceType())) r.continue();
		else r.abort();
	});

	const setShipTo = async (cc, sc) =>
		page.evaluate(
			async (cc, sc) => {
				const res = await fetch('https://www.vivino.com/api/ship_to/', {
					headers: {
						'content-type': 'application/json',
						'x-csrf-token': document.querySelector('[name="csrf-token"]').content,
					},
					body: JSON.stringify({ country_code: cc, state_code: sc }),
					method: 'PUT',
				});
				if (res.status !== 200) return false;
				const j = await res.json();
				return (
					j.ship_to.country_code.toLowerCase() === cc.toLowerCase() &&
					j.ship_to.state_code.toLowerCase() === sc.toLowerCase()
				);
			},
			cc,
			sc,
		);

	const isShipTo = async (cc, sc) =>
		page.evaluate(
			(cc, sc) =>
				cc.toLowerCase() === window.__PRELOADED_COUNTRY_CODE__.toLowerCase() &&
				sc.toLowerCase() === window.__PRELOADED_STATE_CODE__.toLowerCase(),
			cc,
			sc,
		);

	const collectItems = () => {
		const num = (s) => {
			if (!s) return undefined;
			const cleaned = s.replace(/[^0-9,.\-]/g, '');
			// "1.882" (BR thousand) vs "4.3" (decimal). If both . and , present → . is thousand, , is decimal.
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
			const link = linkEl ? new URL(linkEl.getAttribute('href'), 'https://www.vivino.com').href : undefined;

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

	try {
		page.setDefaultNavigationTimeout(60000);
		await page.goto(BASE_URL, { waitUntil: 'networkidle2' });

		try {
			await setShipTo(country, state);
		} catch (_) {
			/* best-effort */
		}

		const MAX_PAGES = Number(params.maxPages) || 3;
		let index = 1;
		let next = false;
		let pause = 0;
		do {
			next = false;
			const r = await page.goto(`${BASE_URL}${SEARCH_PATH}${encodeURIComponent(name)}&start=${index}`, {
				waitUntil: 'networkidle2',
			});
			if (r.ok()) {
				pause = 0;
				try {
					await page.waitForSelector('[data-testid="wineCard"]', { timeout: 10000 });
				} catch (_) {
					result.status = 'FULL_DATA';
					break;
				}
				const items = await page.evaluate(collectItems);
				if (items.length) {
					result.vinos.push(...items);
					index++;
					next = index <= MAX_PAGES;
					if (!next) result.status = 'PAGE_LIMIT';
				} else {
					result.status = 'FULL_DATA';
				}
			} else if (r.status() === 429) {
				pause++;
				await new Promise((res) => setTimeout(res, pause * PAUSE_MULTIPLIER * 1000));
				next = true;
			} else {
				result.http_status = r.status();
				result.page_index = index;
				result.status = 'RESPONSE_ERROR';
			}
		} while (next);

		result.vinos = result.vinos.filter((e) => {
			if (minPrice && (e.price || !noPriceIncluded) && e.price < minPrice) return false;
			if (maxPrice && e.price > maxPrice) return false;
			if (minRatings && e.ratings < minRatings) return false;
			if (maxRatings && e.ratings > maxRatings) return false;
			if (minAverage && e.average_rating < minAverage) return false;
			if (maxAverage && e.average_rating > maxAverage) return false;
			return true;
		});
	} catch (err) {
		result.status = 'SOME_EXCEPTION';
		result.message = String(err);
	} finally {
		await browser.close();
	}
	return result;
};

const toNum = (v) => (v === undefined ? undefined : Number(v));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/search', async (req, res) => {
	const { name } = req.query;
	if (!name) return res.status(400).json({ error: 'name required' });
	try {
		const data = await scrape({
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
		});
		res.json(data);
	} catch (err) {
		res.status(500).json({ error: String(err) });
	}
});

app.listen(PORT, '0.0.0.0', () => {
	console.log(`vivino-api listening on :${PORT}`);
});
