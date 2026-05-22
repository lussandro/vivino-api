const makeMemoryCache = (ttlMs) => {
	const store = new Map();
	return {
		backend: 'memory',
		async get(k) {
			const e = store.get(k);
			if (!e) return undefined;
			if (Date.now() - e.t > ttlMs) {
				store.delete(k);
				return undefined;
			}
			return e.v;
		},
		async set(k, v) {
			store.set(k, { v, t: Date.now() });
		},
		async stats() {
			return { backend: 'memory', size: store.size };
		},
		async close() {},
	};
};

const makeRedisCache = async (url, ttlMs) => {
	const { default: Redis } = await import('ioredis');
	const client = new Redis(url, {
		lazyConnect: true,
		maxRetriesPerRequest: 2,
		enableOfflineQueue: false,
	});
	try {
		await client.connect();
	} catch (err) {
		await client.quit().catch(() => {});
		throw err;
	}
	const prefix = 'vivino:';
	return {
		backend: 'redis',
		async get(k) {
			try {
				const v = await client.get(prefix + k);
				return v ? JSON.parse(v) : undefined;
			} catch (_) {
				return undefined;
			}
		},
		async set(k, v) {
			try {
				await client.set(prefix + k, JSON.stringify(v), 'PX', ttlMs);
			} catch (_) {
				/* ignore */
			}
		},
		async stats() {
			try {
				const keys = await client.keys(prefix + '*');
				return { backend: 'redis', size: keys.length };
			} catch (_) {
				return { backend: 'redis', size: -1 };
			}
		},
		async close() {
			await client.quit().catch(() => {});
		},
	};
};

export const createCache = async ({ ttlMs, redisUrl }) => {
	if (!redisUrl) return makeMemoryCache(ttlMs);
	try {
		const r = await makeRedisCache(redisUrl, ttlMs);
		console.log(`cache: redis @ ${redisUrl}`);
		return r;
	} catch (err) {
		console.warn(`cache: redis connect failed (${err.message}), falling back to memory`);
		return makeMemoryCache(ttlMs);
	}
};
