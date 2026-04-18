import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHttpClient } from './util/http.mjs';
import {
    buildCategoryPayload,
    buildManifest,
    writeJsonAtomic,
} from './writer.mjs';
import { buildHealthReport, readPrevHealth } from './health.mjs';
import { matchImdbToDouban } from './matchers/imdb-to-douban.mjs';
import imdbTop250 from './sources/imdb-top250.mjs';
import criterion from './sources/criterion.mjs';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');

const DEFAULT_MATCHERS = {
    imdb: matchImdbToDouban,
};

const DEFAULT_SOURCES = [imdbTop250, criterion];

// Per PRD §7: Douban endpoints are the binding constraint. Raising any
// of these numbers without coordinating with anti-scrape strategy risks
// getting the whole run blocked.
const DEFAULT_RATE_LIMITS = {
    'search.douban.com': { minDelay: 5000 },
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
 * Matching is resolved per item:
 *   1. If source.matchItem is defined, pipeline calls it — the source
 *      owns the full logic (lookup, fallback, prev-resolved cache, etc.)
 *   2. Otherwise pipeline routes via deps.matchers[source.externalIdKind]
 *      with just raw.externalId — the simple "registry" path
 *
 * @param {Object} source
 * @param {{ fetch: Function }} http
 * @param {{ matchers?: Record<string, Function>, ctx?: Object }} [deps]
 */
export async function runSource(source, http, deps = {}) {
    const matchers = deps.matchers ?? DEFAULT_MATCHERS;
    const ctx = deps.ctx ?? {};
    const updatedAt = new Date();

    const useSourceMatcher = typeof source.matchItem === 'function';
    const registryMatcher = matchers[source.externalIdKind];

    if (!useSourceMatcher && !registryMatcher) {
        return failedResult(
            source,
            updatedAt,
            `no matcher registered for externalIdKind="${source.externalIdKind}" and source has no matchItem()`,
        );
    }

    try {
        const scraped = await source.scrape(http);
        const items = [];
        const unresolved = [];
        for (const raw of scraped) {
            const doubanId = useSourceMatcher
                ? await source.matchItem(raw, http, ctx)
                : await registryMatcher(raw.externalId, http);
            if (doubanId) {
                items.push({
                    doubanId,
                    rank: raw.rank,
                    externalId: raw.externalId,
                });
            } else {
                unresolved.push({
                    externalId: raw.externalId,
                    rank: raw.rank,
                    title: raw.title,
                    year: raw.year,
                });
            }
        }
        if (unresolved.length > 0) {
            console.warn(
                `[${source.id}] ${unresolved.length} unresolved — add to config/manual-mapping.yaml if needed:`,
            );
            for (const u of unresolved) {
                const yearStr = u.year ? ` (${u.year})` : '';
                const rankStr = u.rank != null ? ` rank ${u.rank}` : '';
                console.warn(
                    `  ${u.externalId}${rankStr}  ${u.title ?? ''}${yearStr}`,
                );
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

/**
 * Read previous <category>.json files and build a lookup of already-
 * resolved (source, externalId) → doubanId pairs. Lets sources skip
 * remote matcher calls for items we resolved on a prior run.
 *
 * @returns {Promise<Map<string, Map<string, string>>>} sourceId → (externalId → doubanId)
 */
export async function loadPrevResolved(dataDir = DATA_DIR) {
    const byCategorySource = new Map();
    let manifest;
    try {
        const raw = await readFile(join(dataDir, 'manifest.json'), 'utf-8');
        manifest = JSON.parse(raw);
    } catch {
        return byCategorySource; // no prior run
    }
    for (const cat of manifest?.categories ?? []) {
        let payload;
        try {
            const raw = await readFile(join(dataDir, `${cat}.json`), 'utf-8');
            payload = JSON.parse(raw);
        } catch {
            continue;
        }
        if (payload?.schemaVersion !== 1) continue; // unknown shape, skip
        const items = payload?.categories?.[cat]?.items ?? {};
        for (const [doubanId, entries] of Object.entries(items)) {
            for (const e of entries) {
                if (!e?.source || !e?.externalId) continue;
                if (!byCategorySource.has(e.source)) {
                    byCategorySource.set(e.source, new Map());
                }
                byCategorySource.get(e.source).set(e.externalId, doubanId);
            }
        }
    }
    return byCategorySource;
}

/** Main CLI entry. */
async function main() {
    const http = createHttpClient({
        rateLimits: DEFAULT_RATE_LIMITS,
        jitter: 0.2,
    });
    const prevResolved = await loadPrevResolved();
    const ctx = { prevResolved };
    const results = await runAll(DEFAULT_SOURCES, http, { ctx });
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch(err => {
        console.error('pipeline failed:', err);
        process.exit(1);
    });
}
