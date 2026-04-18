/**
 * Unified HTTP client for all scrapers and matchers.
 *
 * Per-host rate limiting, exponential backoff on 429/5xx, and a single
 * point for User-Agent injection. Every source/matcher MUST route
 * through this client — never call global fetch directly.
 */

const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * @typedef {Object} RateLimit
 * @property {number} minDelay  milliseconds between requests to this host
 *
 * @typedef {Object} HttpClientOptions
 * @property {string} [userAgent]
 * @property {Record<string, RateLimit>} [rateLimits]  keyed by URL hostname
 * @property {number} [defaultMinDelay]
 * @property {number} [maxRetries]
 * @property {number} [backoffBase]  ms — first retry sleeps this long, doubles thereafter
 * @property {number} [backoffMax]   ms — cap on retry sleep
 * @property {number} [jitter]       0..1 fraction; applies ±jitter to each wait to blur regular patterns. Default 0 (deterministic).
 *
 * @typedef {Object} HttpClient
 * @property {(url: string, init?: RequestInit) => Promise<Response>} fetch
 */

/**
 * @param {HttpClientOptions} [options]
 * @returns {HttpClient}
 */
export function createHttpClient(options = {}) {
    const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    const rateLimits = options.rateLimits ?? {};
    const defaultMinDelay = options.defaultMinDelay ?? 2000;
    const maxRetries = options.maxRetries ?? 2;
    const backoffBase = options.backoffBase ?? 5000;
    const backoffMax = options.backoffMax ?? 60000;
    // Jitter as a fraction: 0.2 means ±20% of the waited duration. Default 0
    // keeps deterministic timing for existing tests; production callers
    // (pipeline) opt into jitter to blur regular request patterns.
    const jitter = options.jitter ?? 0;

    /** @type {Map<string, number>} hostname → timestamp of last dispatch */
    const lastRequestAt = new Map();

    async function waitForSlot(hostname) {
        const minDelay = rateLimits[hostname]?.minDelay ?? defaultMinDelay;
        const last = lastRequestAt.get(hostname) ?? 0;
        const wait = last + minDelay - Date.now();
        if (wait > 0) {
            const jittered =
                jitter > 0
                    ? wait * (1 + (Math.random() * 2 - 1) * jitter)
                    : wait;
            await sleep(Math.max(0, jittered));
        }
        lastRequestAt.set(hostname, Date.now());
    }

    async function fetchWithRetry(url, init = {}) {
        const hostname = new URL(url).hostname;
        const { headers: initHeaders, ...rest } = init;
        const headers = { 'User-Agent': userAgent, ...(initHeaders ?? {}) };

        let lastErr;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            await waitForSlot(hostname);
            try {
                const res = await fetch(url, { ...rest, headers });
                if (shouldRetry(res.status) && attempt < maxRetries) {
                    await sleep(backoffFor(attempt, backoffBase, backoffMax));
                    continue;
                }
                return res;
            } catch (err) {
                lastErr = err;
                if (attempt >= maxRetries) throw err;
                await sleep(backoffFor(attempt, backoffBase, backoffMax));
            }
        }
        throw lastErr ?? new Error(`fetch failed: ${url}`);
    }

    return { fetch: fetchWithRetry };
}

function shouldRetry(status) {
    return status === 429 || status >= 500;
}

function backoffFor(attempt, base, max) {
    return Math.min(max, base * 2 ** attempt);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
