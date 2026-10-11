#!/usr/bin/env node
/**
 * Snapshot fetcher: build `config/criterion-snapshot.json`. Runs in CI
 * (update workflow) and locally.
 *
 * criterion.com serves a Cloudflare challenge to every non-residential
 * IP, so the canonical spine list comes from Wikipedia instead.
 *
 * Two-phase fetch:
 *   1. Parse Wikipedia's "List of films in the Criterion Collection"
 *      → canonical CC spine list (~1,300 entries: spine, title, year),
 *      plus any previously published spine the page lacks (spines are
 *      permanent; a gap is a page typo). Fails when the parse yields
 *      fewer than 90% of the published spines, so a reshaped page makes
 *      the pipeline carry the published list forward instead.
 *   2. Scrape Douban doulist 123607960 ("标准收藏 CC 電影全集",
 *      ~1,530 entries, hand-curated) → for each of our CC entries that
 *      matches by year + title overlap, write the curator-picked
 *      doubanId into the snapshot. The pipeline's matchItem prefers
 *      the existing matcher chain (manual-mapping → IMDB datasets →
 *      PtGen) and only falls back to the doulist doubanId for entries
 *      those layers can't resolve — so doulist strictly EXPANDS coverage
 *      without reshuffling the 1,130 entries already mapped.
 *
 * Usage:
 *   pnpm run fetch:criterion-snapshot
 *
 * Cadence: runs with every monthly update in CI (Criterion adds ~5-10
 * spines/month).
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseWikipediaList,
    addPublishedSpines,
    CRITERION_WIKIPEDIA_LIST_URL,
} from '../src/sources/criterion.mjs';
import { fetchViaCurl, scrapeDoulistAll, normalizeForMatch } from './lib/doulist.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'criterion-snapshot.json');
const PUBLISHED_MOVIE_PATH = join(PROJECT_ROOT, 'data', 'movie.json');
const MIN_PARSED_RATIO = 0.9;

const DOULIST_ID = '123607960';
const DOULIST_DELAY_MS = 2500;

function buildYearIndex(doulistEntries) {
    const map = new Map();
    for (const e of doulistEntries) {
        if (!e.year) continue;
        const arr = map.get(e.year) ?? [];
        arr.push(e);
        map.set(e.year, arr);
    }
    return map;
}

function resolveDoulistByTitle(ccEntry, yearIndex) {
    const { title, year } = ccEntry;
    if (!year) return null;
    const titleNorm = normalizeForMatch(title);
    if (!titleNorm) return null;
    // Pass 1: exact year + normalized substring match (cheap, high precision).
    const same = yearIndex.get(String(year)) ?? [];
    for (const c of same) {
        const n = normalizeForMatch(c.title);
        if (n.includes(titleNorm) || titleNorm.includes(n)) return c;
    }
    // Pass 2: year ±1 + substring. CC year (release/restoration) sometimes
    // differs from Douban's "年份" (original theatrical release).
    for (const offset of [-1, 1]) {
        const arr = yearIndex.get(String(Number(year) + offset)) ?? [];
        for (const c of arr) {
            const n = normalizeForMatch(c.title);
            if (n.includes(titleNorm) || titleNorm.includes(n)) return c;
        }
    }
    return null;
}

async function loadExistingCcList() {
    try {
        const raw = await readFile(SNAPSHOT_PATH, 'utf-8');
        const prev = JSON.parse(raw);
        if (Array.isArray(prev?.items) && prev.items.length > 0) return prev.items;
    } catch {
        // fall through
    }
    return null;
}

async function loadPublishedMovie() {
    try {
        const json = JSON.parse(await readFile(PUBLISHED_MOVIE_PATH, 'utf-8'));
        return json?.schemaVersion === 1 ? json : null;
    } catch {
        return null;
    }
}

async function main() {
    console.log(`Fetching ${CRITERION_WIKIPEDIA_LIST_URL} (via system curl)`);
    const { status, body } = await fetchViaCurl(CRITERION_WIKIPEDIA_LIST_URL);
    let items;
    if (status === 200) {
        const parsed = parseWikipediaList(body);
        const published = await loadPublishedMovie();
        const publishedCount =
            published?.categories?.movie?.sources?.criterion?.itemCount ?? 0;
        const floor = Math.floor(publishedCount * MIN_PARSED_RATIO);
        if (parsed.length < floor) {
            console.error(
                `Parsed only ${parsed.length} spines (expected ≥ ${floor}) — the Wikipedia page may have changed structure.`,
            );
            process.exit(1);
        }
        items = addPublishedSpines(parsed, published);
        console.log(
            `Parsed ${parsed.length} CC spines from Wikipedia; kept ${items.length - parsed.length} published spines missing from it`,
        );
    } else {
        console.warn(`Wikipedia HTTP ${status} — using existing snapshot as CC list.`);
        const existing = await loadExistingCcList();
        if (!existing) {
            console.error('No existing snapshot to fall back on. Retry later.');
            process.exit(1);
        }
        // Strip any prior doubanId — we'll re-derive from this run's doulist.
        items = existing.map(({ doubanId, ...rest }) => rest);
        console.log(`Using ${items.length} existing CC spines (criterion.com blocked).`);
    }

    console.log(`\nScraping doulist ${DOULIST_ID} (this takes ~3 min)…`);
    const rawEntries = await scrapeDoulistAll(DOULIST_ID, {
        delayMs: DOULIST_DELAY_MS,
        onPage: ({ start, count }) => console.log(`  doulist page start=${start}… ${count} items`),
    });
    // The shared helper pulls year from 评语; CC doulist has year in
    // `年份: YYYY` inside .abstract instead. Override.
    const doulistEntries = rawEntries.map(e => {
        const m = e.abstract.match(/年份[:：]\s*(\d{4})/);
        return { ...e, year: m ? m[1] : null };
    });
    console.log(`Collected ${doulistEntries.length} doulist entries (${doulistEntries.filter(e => e.year).length} with year)`);
    const yearIndex = buildYearIndex(doulistEntries);

    // Augment items with doulist-picked doubanId where a match exists.
    let matched = 0;
    const enriched = items.map(it => {
        const hit = resolveDoulistByTitle(it, yearIndex);
        if (hit) matched++;
        return hit ? { ...it, doubanId: hit.dbid } : it;
    });
    console.log(`\nMatched ${matched} / ${items.length} CC entries against doulist`);

    const payload = {
        generatedAt: new Date().toISOString(),
        source: CRITERION_WIKIPEDIA_LIST_URL,
        count: enriched.length,
        doulistSource: `https://www.douban.com/doulist/${DOULIST_ID}/`,
        doulistMatched: matched,
        items: enriched,
    };
    await mkdir(dirname(SNAPSHOT_PATH), { recursive: true });
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify(payload, null, 2) + '\n',
        'utf-8',
    );
    console.log(`Wrote ${enriched.length} entries to ${SNAPSHOT_PATH}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
