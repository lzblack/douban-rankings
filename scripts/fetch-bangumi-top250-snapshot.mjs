#!/usr/bin/env node
/**
 * Maintainer utility: build `config/bangumi-top250-snapshot.json`.
 *
 * Resolution strategy (v2, 2026-04-20):
 *   Step A. Scrape bgm.tv anime rank pages 1-11 → canonical Top 250 list
 *     (rank, bangumiId, Chinese title, year). ~20 s at 1.5 s/page.
 *   Step B. Scrape Douban doulist 46366667 ("Bangumi Top 250（动画篇）",
 *     ~286 entries, updated 3×/month by a Douban user). Each entry has
 *     dbid in URL, Chinese+Japanese titles in .title, year in .abstract
 *     ("年份: YYYY"). 12 pages ≈ 36 s.
 *   Step C. Match bgm.tv ↔ doulist by year + title overlap:
 *     Pass 1: exact year + our title is a substring of doulist title
 *       (doulist title usually is "中文 日本語" concatenated, so our
 *       bgm.tv Chinese title almost always substring-fits when it's the
 *       same anime).
 *     Pass 2: exact year + CJK Jaccard similarity ≥ 0.45 to disambiguate
 *       sequels and re-releases that share a root title.
 *     Pass 3: year ±1 + substring match (for animes whose bgm.tv year
 *       and Douban year differ by 1 — TV first-air-year vs movie-release
 *       etc).
 *   Entries unresolved after all passes fall back to the previous
 *   snapshot's dbid if any, else stay unresolved (logged for maintainer).
 *
 * Why not rank match? Doulist syncs ~3×/month; bgm.tv updates live.
 * Observed drift (2026-04-20): bgm rank 3 vs doulist pos 4 for the same
 * anime. Rank is unreliable; title+year is deterministic.
 *
 * Run from residential IP. Expect ~60 seconds.
 *
 *   pnpm run fetch:bangumi-top250-snapshot
 */

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as cheerio from 'cheerio';
import { parseList } from '../src/sources/bangumi-top250.mjs';

const execFileP = promisify(execFile);

const LIST_BASE = 'https://bgm.tv/anime/browser';
const PAGE_COUNT = 11;
const TOP_N = 250;

const DOULIST_ID = '46366667';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'bangumi-top250-snapshot.json');

const BGM_DELAY_MS = 1500;
const DOUBAN_DELAY_MS = 3000;

async function fetchViaCurl(url, { langHeader = 'en-US,en;q=0.9' } = {}) {
    const { stdout } = await execFileP(
        'curl',
        [
            '-sSL',
            '--compressed',
            '-A',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            '-H',
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            '-H',
            `Accept-Language: ${langHeader}`,
            '-w',
            '\\nHTTP_STATUS:%{http_code}',
            url,
        ],
        { maxBuffer: 32 * 1024 * 1024, encoding: 'utf-8' },
    );
    const match = stdout.match(/\nHTTP_STATUS:(\d+)$/);
    if (!match) throw new Error(`curl missing HTTP_STATUS for ${url}`);
    const status = Number(match[1]);
    const body = stdout.slice(0, stdout.length - match[0].length);
    return { status, body };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const CN_NUM_TO_INT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ROMAN_LOWER_TO_INT = { 'ⅰ': 1, 'ⅱ': 2, 'ⅲ': 3, 'ⅳ': 4, 'ⅴ': 5, 'ⅵ': 6, 'ⅶ': 7, 'ⅷ': 8, 'ⅸ': 9, 'ⅹ': 10 };
const ASCII_ROMAN_TO_INT = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/** Normalize for fuzzy title match:
 *  1. Collapse sequel markers (第X季, Season X, II, Ⅱ, etc.) to a common
 *     token "s<N>" — otherwise "灵能百分百 第二季" (bgm.tv) and "灵能百分百
 *     II モブサイコ100 II" (doulist) share only base-title characters
 *     and miss the threshold.
 *  2. Lowercase, strip everything except CJK + ASCII alphanumerics. */
function normalizeForMatch(s) {
    let t = String(s).toLowerCase();
    t = t.replace(/第([一二三四五六七八九十])季/g, (_, n) => ` s${CN_NUM_TO_INT[n]} `);
    t = t.replace(/第(\d+)季/g, (_, n) => ` s${n} `);
    t = t.replace(/\bseason\s*(\d+)\b/gi, (_, n) => ` s${n} `);
    t = t.replace(/[ⅰ-ⅹ]/g, ch => ` s${ROMAN_LOWER_TO_INT[ch] ?? ''} `);
    t = t.replace(/\b(iii|ii|iv|viii|vii|vi|v|ix|x)\b/g, (_, r) => ` s${ASCII_ROMAN_TO_INT[r] ?? ''} `);
    return t.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9 ]/gu, '').replace(/\s+/g, '');
}

/** Character-level Jaccard similarity — how much of the two titles'
 *  normalized character sets overlap. Robust to word reordering and
 *  punctuation, which matters for Japanese-Chinese mixed titles. */
function jaccardScore(a, b) {
    const sa = new Set(normalizeForMatch(a));
    const sb = new Set(normalizeForMatch(b));
    if (sa.size === 0 || sb.size === 0) return 0;
    let inter = 0;
    for (const ch of sa) if (sb.has(ch)) inter++;
    return inter / (sa.size + sb.size - inter);
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
            if (title && dbid) entries.push({ dbid, title, abstract, year });
        }
        if (items.length < 25) break;
        start += 25;
        await sleep(DOUBAN_DELAY_MS);
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

function resolveByTitle(bgmEntry, yearIndex) {
    const { title, year } = bgmEntry;
    const titleNorm = normalizeForMatch(title);
    if (!titleNorm) return null;

    // Pass 1: year exact + substring match.
    for (const yearOffset of [0]) {
        const y = String(Number(year) + yearOffset);
        const candidates = yearIndex.get(y) ?? [];
        // Prefer substring match on normalized form.
        const substr = candidates.find(c => {
            const n = normalizeForMatch(c.title);
            return n.includes(titleNorm) || titleNorm.includes(n);
        });
        if (substr) return { entry: substr, method: 'year + substring' };
    }

    // Pass 2: year exact + best Jaccard ≥ 0.45.
    const sameYear = yearIndex.get(String(year)) ?? [];
    let best = null;
    for (const c of sameYear) {
        const score = jaccardScore(title, c.title);
        if (score >= 0.45 && (!best || score > best.score)) best = { entry: c, score };
    }
    if (best) return { entry: best.entry, method: `year + jaccard=${best.score.toFixed(2)}` };

    // Pass 3: year ±1 + substring match.
    for (const yearOffset of [-1, 1]) {
        const y = String(Number(year) + yearOffset);
        const candidates = yearIndex.get(y) ?? [];
        const substr = candidates.find(c => {
            const n = normalizeForMatch(c.title);
            return n.includes(titleNorm) || titleNorm.includes(n);
        });
        if (substr) return { entry: substr, method: `year±1 + substring` };
    }

    return null;
}

async function main() {
    const existing = new Map();
    try {
        const raw = await readFile(SNAPSHOT_PATH, 'utf-8');
        const prev = JSON.parse(raw);
        for (const it of prev?.items ?? []) {
            if (it.bangumiId && it.doubanId) existing.set(it.bangumiId, it.doubanId);
        }
        console.log(`Loaded ${existing.size} previously-resolved doubanIds for fallback`);
    } catch {
        // first run
    }

    // Phase 1: scrape bgm.tv
    const scraped = [];
    for (let page = 1; page <= PAGE_COUNT; page++) {
        const url = `${LIST_BASE}?sort=rank&page=${page}`;
        console.log(`[bgm] page ${page}`);
        const res = await fetchViaCurl(url, { langHeader: 'zh-CN,zh;q=0.9,en;q=0.8' });
        if (res.status !== 200) {
            console.error(`bgm page ${page} HTTP ${res.status}`);
            process.exit(1);
        }
        scraped.push(...parseList(res.body));
        if (scraped.length >= TOP_N) break;
        await sleep(BGM_DELAY_MS);
    }
    const entries = scraped.slice(0, TOP_N);
    console.log(`Scraped ${entries.length} bgm.tv entries`);

    // Phase 2: scrape doulist
    console.log(`\nScraping doulist ${DOULIST_ID}…`);
    const doulistEntries = await scrapeDoulistAll(DOULIST_ID);
    console.log(`Collected ${doulistEntries.length} doulist entries (${doulistEntries.filter(e => e.year).length} with year)`);
    const yearIndex = buildYearIndex(doulistEntries);

    // Phase 3: match
    const items = [];
    let viaDoulist = 0, viaFallback = 0, unresolved = 0;
    const byMethod = new Map();
    for (const e of entries) {
        const resolved = resolveByTitle(e, yearIndex);
        const prevDbid = existing.get(e.bangumiId);
        let dbid = null;
        let provenance = '';
        if (resolved) {
            dbid = resolved.entry.dbid;
            provenance = `doulist (${resolved.method})`;
            viaDoulist++;
            byMethod.set(resolved.method, (byMethod.get(resolved.method) ?? 0) + 1);
        } else if (prevDbid) {
            dbid = prevDbid;
            provenance = 'fallback (prev snapshot)';
            viaFallback++;
        } else {
            provenance = 'UNRESOLVED';
            unresolved++;
        }
        items.push({ ...e, ...(dbid ? { doubanId: dbid } : {}) });
        if (!resolved) {
            console.log(`  [rank=${e.rank}] ${e.title} (${e.year})  → ${dbid ?? '—'}  [${provenance}]`);
        }
    }

    console.log(`\nMethod distribution:`);
    for (const [method, count] of byMethod.entries()) console.log(`  ${method}: ${count}`);

    const resolved = items.filter(it => it.doubanId).length;
    const payload = {
        generatedAt: new Date().toISOString(),
        source: LIST_BASE,
        count: items.length,
        resolvedCount: resolved,
        items,
    };
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify(payload, null, 2) + '\n',
        'utf-8',
    );
    console.log(
        `\nWrote ${items.length} entries (${resolved} resolved) to ${SNAPSHOT_PATH}\n` +
            `  matched via doulist: ${viaDoulist}\n` +
            `  fallback to prev: ${viaFallback}\n` +
            `  unresolved: ${unresolved}\n` +
            `Next: git add config/bangumi-top250-snapshot.json && git commit && git push`,
    );
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
