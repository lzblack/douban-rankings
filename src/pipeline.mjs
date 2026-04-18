import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHttpClient } from './util/http.mjs';
import {
    buildCategoryPayload,
    buildManifest,
    writeJsonAtomic,
} from './writer.mjs';
import { buildHealthReport, readPrevHealth } from './health.mjs';
import { matchImdbToDouban } from './matchers/imdb-to-douban.mjs';
import imdbTop250 from './sources/imdb-top250.mjs';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');

const DEFAULT_MATCHERS = {
    imdb: matchImdbToDouban,
};

const DEFAULT_SOURCES = [imdbTop250];

// Per PRD §7: Douban redirect is the binding constraint at 5s/req.
// Raising any of these numbers without coordinating with anti-scrape
// strategy risks getting the whole run blocked.
const DEFAULT_RATE_LIMITS = {
    'movie.douban.com': { minDelay: 5000 },
    'www.douban.com': { minDelay: 8000 },
    'www.imdb.com': { minDelay: 2000 },
    'www.criterion.com': { minDelay: 2000 },
};

/**
 * Run one source end-to-end: scrape → per-item match → collect.
 * Never throws — returns a result object with status=failed on error,
 * so callers can isolate one source's failure from others.
 *
 * @param {Object} source
 * @param {{ fetch: Function }} http
 * @param {{ matchers?: Record<string, Function> }} [deps]
 */
export async function runSource(source, http, deps = {}) {
    const matchers = deps.matchers ?? DEFAULT_MATCHERS;
    const matcher = matchers[source.externalIdKind];
    const updatedAt = new Date();

    if (!matcher) {
        return failedResult(
            source,
            updatedAt,
            `no matcher registered for externalIdKind="${source.externalIdKind}"`,
        );
    }

    try {
        const scraped = await source.scrape(http);
        const items = [];
        for (const raw of scraped) {
            const doubanId = await matcher(raw.externalId, http);
            if (doubanId) {
                items.push({
                    doubanId,
                    rank: raw.rank,
                    externalId: raw.externalId,
                });
            }
        }
        return {
            id: source.id,
            sourceDef: source,
            status: 'ok',
            itemCount: items.length,
            scrapedCount: scraped.length,
            items,
            updatedAt,
            message: null,
        };
    } catch (err) {
        return failedResult(source, updatedAt, err.message ?? String(err));
    }
}

function failedResult(source, updatedAt, message) {
    return {
        id: source.id,
        sourceDef: source,
        status: 'failed',
        itemCount: 0,
        scrapedCount: 0,
        items: [],
        updatedAt,
        message,
    };
}

/**
 * Run sources sequentially so per-host rate limits in the HTTP client
 * actually serialize. Running in parallel would defeat the limiter.
 *
 * @param {Object[]} sources
 * @param {{ fetch: Function }} http
 */
export async function runAll(sources, http, deps = {}) {
    const results = [];
    for (const source of sources) {
        results.push(await runSource(source, http, deps));
    }
    return results;
}

/**
 * Group only successful source results by category. Failed sources are
 * excluded from published JSON but still recorded in the health report.
 */
export function groupByCategory(results) {
    const byCat = {};
    for (const r of results) {
        if (r.status !== 'ok') continue;
        const cat = r.sourceDef.category;
        (byCat[cat] ??= []).push(r);
    }
    return byCat;
}

/** Main CLI entry. */
async function main() {
    const http = createHttpClient({ rateLimits: DEFAULT_RATE_LIMITS });
    const results = await runAll(DEFAULT_SOURCES, http);
    const now = new Date();

    const byCat = groupByCategory(results);
    const categoryIds = Object.keys(byCat).sort();

    for (const cat of categoryIds) {
        const payload = buildCategoryPayload(cat, byCat[cat], { now });
        await writeJsonAtomic(join(DATA_DIR, `${cat}.json`), payload);
    }

    const manifest = buildManifest(categoryIds, { now });
    await writeJsonAtomic(join(DATA_DIR, 'manifest.json'), manifest);

    const prevHealth = await readPrevHealth(join(DATA_DIR, 'health.json'));
    const health = buildHealthReport(
        prevHealth,
        results.map(r => ({
            id: r.id,
            status: r.status,
            itemCount: r.itemCount,
            message: r.message,
            runAt: r.updatedAt,
        })),
        { now },
    );
    await writeJsonAtomic(join(DATA_DIR, 'health.json'), health);

    printSummary(results, health);

    // Exit non-zero when every source failed so the Actions run shows red
    // and the health-alert workflow fires.
    if (health.overall === 'failed') process.exit(1);
}

function printSummary(results, health) {
    console.log('\n--- summary ---');
    for (const r of results) {
        if (r.status === 'ok') {
            console.log(
                `  [ok]   ${r.id}: ${r.itemCount}/${r.scrapedCount} matched`,
            );
        } else {
            console.log(`  [fail] ${r.id}: ${r.message}`);
        }
    }
    console.log(`overall: ${health.overall}`);
}

// CLI entry — runs when this module is invoked directly (e.g. `pnpm run update`)
// but not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch(err => {
        console.error('pipeline failed:', err);
        process.exit(1);
    });
}
