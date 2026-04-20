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
import { parseList } from '../src/sources/bangumi-top250.mjs';
import { fetchViaCurl, scrapeDoulistAll, normalizeForMatch, jaccardScore } from './lib/doulist.mjs';

const LIST_BASE = 'https://bgm.tv/anime/browser';
const PAGE_COUNT = 11;
const TOP_N = 250;

const DOULIST_ID = '46366667';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'bangumi-top250-snapshot.json');

const BGM_DELAY_MS = 1500;
const DOULIST_DELAY_MS = 3000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

    // Pass 2: year exact + best Jaccard ≥ 0.45 on normalized char sets.
    const sameYear = yearIndex.get(String(year)) ?? [];
    let best = null;
    for (const c of sameYear) {
        const score = jaccardScore(normalizeForMatch(title), normalizeForMatch(c.title));
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
        const res = await fetchViaCurl(url, { acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' });
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

    // Phase 2: scrape doulist. The shared helper extracts year from 评语;
    // Bangumi's doulist puts rank info there and the production year in
    // .abstract (`年份: YYYY`), so override.
    console.log(`\nScraping doulist ${DOULIST_ID}…`);
    const rawEntries = await scrapeDoulistAll(DOULIST_ID, {
        delayMs: DOULIST_DELAY_MS,
        onPage: ({ start, count }) => console.log(`  doulist page start=${start}… ${count} items`),
    });
    const doulistEntries = rawEntries.map(e => {
        const m = e.abstract.match(/年份[:：]\s*(\d{4})/);
        return { ...e, year: m ? m[1] : null };
    });
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
