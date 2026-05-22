import minimist from 'minimist';
import fs from 'fs-extra';
import { launchBrowser, scrape } from './lib/scraper.js';

const args = minimist(process.argv.slice(2));
console.log(args);

const { name, country, state, minPrice, maxPrice, noPriceIncluded, minRatings, maxRatings, minAverage, maxAverage, maxPages, out } = args;

if (!name) {
	console.error('--name is required');
	process.exit(1);
}

const outFile = out || 'vivino-out.json';

const browser = await launchBrowser();
try {
	const result = await scrape(
		browser,
		{
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
			maxPages,
		},
		{
			concurrency: Number(args.concurrency) || 3,
			log: (msg) => console.log(msg),
		},
	);
	await fs.writeFile(outFile, JSON.stringify(result, null, 2));
	console.log(`wrote ${result.vinos.length} items to ${outFile} (status: ${result.status})`);
} catch (err) {
	console.error('Exception:', err);
	process.exit(1);
} finally {
	await browser.close();
}
