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
import imdbTop250Tv from './sources/imdb-top250-tv.mjs';
import criterion from './sources/criterion.mjs';
import afiTop100 from './sources/afi-top100.mjs';
import bfiSs2022 from './sources/bfi-ss-2022.mjs';
import letterboxdTop250 from './sources/letterboxd-top250.mjs';
import tspdt1000 from './sources/tspdt-1000.mjs';
import bangumiTop250 from './sources/bangumi-top250.mjs';
import grammyAoty from './sources/grammy-aoty.mjs';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(PROJECT_ROOT, 'data');

const DEFAULT_MATCHERS = {
    imdb: matchImdbToDouban,
};

const DEFAULT_SOURCES = [
    imdbTop250,
    imdbTop250Tv,
    criterion,
    afiTop100,
    bfiSs2022,
    letterboxdTop250,
    tspdt1000,
    bangumiTop250,
    grammyAoty,
];

// Per PRD §7: Douban endpoints are the binding constraint. Raising any
// of these numbers without coordinating with anti-scrape strategy risks
// getting the whole run blocked.
const DEFAULT_RATE_LIMITS = {
    'search.douban.com': { minDelay: 5000 },
    'movie.douban.com': { minDelay: 5000 },
    'www.douban.com': { minDelay: 8000 },
    'www.imdb.com': { minDelay: 2000 },
    'www.criterion.com': { minDelay: 2000 },
    'en.wikipedia.org': { minDelay: 1000 },
    'bgm.tv': { minDelay: 2000 },
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
        const resolvedExternalIds = new Set();
        const unresolved = [];
        for (const raw of scraped) {
            // Matchers return string[] (possibly multiple dbids per
            // externalId — same film, different Douban subject pages
            // per release/restoration). Older single-value return is
            // normalized to one-item array for back-compat.
            const raw_result = useSourceMatcher
                ? await source.matchItem(raw, http, ctx)
                : await registryMatcher(raw.externalId, http);
            const doubanIds = normalizeMatchResult(raw_result);
            if (doubanIds.length > 0) {
                resolvedExternalIds.add(raw.externalId);
                for (const doubanId of doubanIds) {
                    const entry = {
                        doubanId,
                        rank: raw.rank,
                        externalId: raw.externalId,
                    };
                    if (raw.spineNumber != null) {
                        entry.spineNumber = raw.spineNumber;
                    }
                    items.push(entry);
                }
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
            // itemCount = unique externalIds matched (source coverage),
            // NOT the total expanded entries — expansion into multiple
            // dbids per tt shouldn't inflate the stats.
            itemCount: resolvedExternalIds.size,
            scrapedCount: scraped.length,
            items,
            updatedAt,
            message: null,
        };
    } catch (err) {
        return failedResult(source, updatedAt, err.message ?? String(err));
    }
}

/**
 * Normalize a matcher's return shape: accepts string[], single string,
 * or null/undefined. Used during the migration to array returns so
 * older matchers (or test fakes) still work.
 */
function normalizeMatchResult(r) {
    if (Array.isArray(r)) return r.filter(Boolean).map(String);
    if (r == null) return [];
    return [String(r)];
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
                // Same (source, externalId) can appear under multiple
                // doubanIds (multi-version expansion). Collect them all
                // so the matcher's cache short-circuit returns every
                // version, not just the first one seen.
                const bySrc = byCategorySource.get(e.source);
                const existing = bySrc.get(e.externalId);
                if (Array.isArray(existing)) {
                    if (!existing.includes(String(doubanId))) {
                        existing.push(String(doubanId));
                    }
                } else {
                    bySrc.set(e.externalId, [String(doubanId)]);
                }
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
