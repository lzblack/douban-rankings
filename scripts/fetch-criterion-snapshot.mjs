#!/usr/bin/env node
/**
 * Maintainer utility: fetch the Criterion Collection browse/list page
 * and produce `config/criterion-snapshot.json`.
 *
 * Run this from a residential IP (home / office). criterion.com
 * returns HTTP 403 for GitHub Actions runners and other cloud
 * providers, so the pipeline can't fetch it directly — instead it
 * reads the committed snapshot this script produces.
 *
 * Two-phase fetch:
 *   1. Scrape criterion.com/shop/browse/list → canonical CC spine list
 *      (~1,300 entries: spine number, title, year, slug).
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
 * Cadence: quarterly is plenty (Criterion adds ~5-10 spines/month).
 */

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as cheerio from 'cheerio';
import { parseList, CRITERION_LIST_URL } from '../src/sources/criterion.mjs';

const execFileP = promisify(execFile);

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'criterion-snapshot.json');

const DOULIST_ID = '123607960';
const DOULIST_DELAY_MS = 2500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const CN_NUM_TO_INT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ROMAN_LOWER_TO_INT = { 'ⅰ': 1, 'ⅱ': 2, 'ⅲ': 3, 'ⅳ': 4, 'ⅴ': 5, 'ⅵ': 6, 'ⅶ': 7, 'ⅷ': 8, 'ⅸ': 9, 'ⅹ': 10 };
const ASCII_ROMAN_TO_INT = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/** Normalize for fuzzy title match (shared shape with bangumi fetcher;
 *  see that script for rationale). */
function normalizeForMatch(s) {
    let t = String(s).toLowerCase();
    t = t.replace(/第([一二三四五六七八九十])季/g, (_, n) => ` s${CN_NUM_TO_INT[n]} `);
    t = t.replace(/第(\d+)季/g, (_, n) => ` s${n} `);
    t = t.replace(/\bseason\s*(\d+)\b/gi, (_, n) => ` s${n} `);
    t = t.replace(/[ⅰ-ⅹ]/g, ch => ` s${ROMAN_LOWER_TO_INT[ch] ?? ''} `);
    t = t.replace(/\b(iii|ii|iv|viii|vii|vi|v|ix|x)\b/g, (_, r) => ` s${ASCII_ROMAN_TO_INT[r] ?? ''} `);
    return t.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9 ]/gu, '').replace(/\s+/g, '');
}

// Criterion's edge filter rejects requests whose TLS fingerprint isn't a
// real browser's — Node's undici fetch has a distinct JA3 and gets 403
// even on residential IPs. Shelling out to the system curl (same binary
// that returns 200 in a terminal) sidesteps fingerprinting entirely.
async function fetchViaCurl(url) {
    const { stdout } = await execFileP(
        'curl',
        [
            '-sSL',
            '--compressed',
            '-A',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            '-H', 'Accept-Language: en-US,en;q=0.9',
            '-w', '\\nHTTP_STATUS:%{http_code}',
            url,
        ],
        {
            maxBuffer: 64 * 1024 * 1024, // 64MB — Criterion page is ~1.5MB
            encoding: 'utf-8',
        },
    );
    const match = stdout.match(/\nHTTP_STATUS:(\d+)$/);
    if (!match) {
        throw new Error('curl output missing HTTP_STATUS marker');
    }
    const status = Number(match[1]);
    const body = stdout.slice(0, stdout.length - match[0].length);
    return { status, body };
}

async function scrapeDoulistAll(doulistId) {
    const entries = [];
    let start = 0;
    while (true) {
        const url = `https://www.douban.com/doulist/${doulistId}/?start=${start}`;
        process.stdout.write(`  doulist page start=${start}… `);
        const res = await fetchViaCurl(url);
        if (res.status !== 200) {
            throw new Error(`doulist ${doulistId} HTTP ${res.status} at start=${start}`);
        }
        const $ = cheerio.load(res.body);
        const items = $('.doulist-item').toArray();
        console.log(`${items.length} items`);
        if (items.length === 0) break;
        for (const el of items) {
            const $el = $(el);
            const href = $el.find('.title a').attr('href') || '';
            const m = href.match(/subject\/(\d+)/);
            if (!m) continue;
            const dbid = m[1];
            const title = $el.find('.title a').text().trim();
            const abstract = $el.find('.abstract').text().replace(/\s+/g, ' ').trim();
            const yearMatch = abstract.match(/年份[:：]\s*(\d{4})/);
            const year = yearMatch ? yearMatch[1] : null;
            if (title && dbid) entries.push({ dbid, title, year });
        }
        start += 25;
        await sleep(DOULIST_DELAY_MS);
    }
    return entries;
}

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

async function main() {
    console.log(`Fetching ${CRITERION_LIST_URL} (via system curl)`);
    const { status, body } = await fetchViaCurl(CRITERION_LIST_URL);
    let items;
    if (status === 200) {
        items = parseList(body);
        if (items.length === 0) {
            console.error(
                'Parsed zero entries — the page may have changed structure. Inspect the HTML manually.',
            );
            process.exit(1);
        }
        console.log(`Parsed ${items.length} CC spines from criterion.com`);
    } else {
        console.warn(`criterion.com HTTP ${status} — using existing snapshot as CC list.`);
        const existing = await loadExistingCcList();
        if (!existing) {
            console.error('No existing snapshot to fall back on. Retry from a residential IP.');
            process.exit(1);
        }
        // Strip any prior doubanId — we'll re-derive from this run's doulist.
        items = existing.map(({ doubanId, ...rest }) => rest);
        console.log(`Using ${items.length} existing CC spines (criterion.com blocked).`);
    }

    console.log(`\nScraping doulist ${DOULIST_ID} (this takes ~3 min)…`);
    const doulistEntries = await scrapeDoulistAll(DOULIST_ID);
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
        source: CRITERION_LIST_URL,
        count: enriched.length,
        doulistSource: `https://www.douban.com/doulist/${DOULIST_ID}/`,
        doulistMatched: matched,
        items: enriched,
    };
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify(payload, null, 2) + '\n',
        'utf-8',
    );
    console.log(`Wrote ${enriched.length} entries to ${SNAPSHOT_PATH}`);
    console.log('Next: git add config/criterion-snapshot.json && git commit && git push');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
