#!/usr/bin/env node
/**
 * Maintainer utility: build `config/grammy-aoty-snapshot.json`.
 *
 * Resolution strategy (v2, 2026-04-20):
 *   Step A. Scrape Wikipedia Grammy AOTY page → canonical winners list
 *     (year / artist / title), ~68 rows across per-decade wikitables.
 *   Step B. Scrape Douban doulist 12039871 ("历届格莱美年度最佳专辑",
 *     ~67 entries, hand-curated). Each entry has dbid in URL; 评语 has
 *     ceremony year. 3 pages = 3 requests.
 *   Step C. Match by ceremony year extracted from 评语.
 *     Pass 1: single-candidate years.
 *     Pass 2: for doulist entries whose 评语 has no parseable year, match
 *       by English title substring in 评语.
 *     Pass 3: for ambiguous years with multiple candidates, fetch each
 *       candidate's music.douban.com subject page, read 原作名, match.
 *   Entries unresolved after all passes fall back to the previous
 *   snapshot's dbid if any.
 *
 * Why not title match? Doulist sometimes uses Chinese translated or
 * stylized album names. Year match is deterministic.
 *
 * Run from residential IP. Expect ~30 seconds.
 *
 *   pnpm run fetch:grammy-aoty-snapshot
 */

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { parseList, GRAMMY_AOTY_LIST_URL } from '../src/sources/grammy-aoty.mjs';
import { fetchViaCurl, scrapeDoulistAll } from './lib/doulist.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'grammy-aoty-snapshot.json');

const DOULIST_ID = '12039871';
const SUBJECT_DOMAIN = 'music.douban.com';
const DOULIST_DELAY_MS = 3000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchOriginalTitle(dbid) {
    const url = `https://${SUBJECT_DOMAIN}/subject/${dbid}/`;
    const res = await fetchViaCurl(url);
    if (res.status !== 200) return null;
    const $ = cheerio.load(res.body);
    const info = $('#info').text().replace(/\s+/g, ' ').trim();
    // Music subject pages expose the original title under 专辑名 / 又名
    // / 原名; try each in order.
    for (const label of ['又名', '原名', '专辑名']) {
        const re = new RegExp(`${label}:\\s*(.+?)(?:\\s+[^\\s:]+:|$)`);
        const m = info.match(re);
        if (m && m[1]) return m[1].trim();
    }
    return null;
}

async function main() {
    const existing = new Map();
    try {
        const raw = await readFile(SNAPSHOT_PATH, 'utf-8');
        const prev = JSON.parse(raw);
        for (const it of prev?.items ?? []) {
            if (it.externalId && it.doubanId) existing.set(it.externalId, it.doubanId);
        }
        console.log(`Loaded ${existing.size} previously-resolved dbids for fallback`);
    } catch {
        // first run
    }

    console.log(`Fetching list: ${GRAMMY_AOTY_LIST_URL}`);
    const listRes = await fetchViaCurl(GRAMMY_AOTY_LIST_URL);
    if (listRes.status !== 200) {
        console.error(`list HTTP ${listRes.status}`);
        process.exit(1);
    }
    const entries = parseList(listRes.body);
    console.log(`Parsed ${entries.length} winners from Wikipedia`);

    console.log(`\nScraping doulist ${DOULIST_ID}…`);
    const doulistEntries = await scrapeDoulistAll(DOULIST_ID, {
        delayMs: DOULIST_DELAY_MS,
        onPage: ({ start, count }) => console.log(`  doulist page start=${start}… ${count} items`),
    });
    console.log(`Collected ${doulistEntries.length} doulist entries`);

    const yearMap = new Map();
    const noYearEntries = [];
    for (const e of doulistEntries) {
        if (!e.year) { noYearEntries.push(e); continue; }
        const arr = yearMap.get(e.year) ?? [];
        arr.push(e);
        yearMap.set(e.year, arr);
    }
    if (noYearEntries.length > 0) {
        console.log(`  ${noYearEntries.length} doulist entries had no year in comment (Pass 2 candidates)`);
    }
    const multiYears = [...yearMap.entries()].filter(([, v]) => v.length > 1);
    if (multiYears.length > 0) {
        console.log(`  Multi-candidate years: ${multiYears.map(([y, v]) => `${y}×${v.length}`).join(', ')}`);
    }

    // Pass 2 lookup: no-year doulist entries → Wiki externalId via EN title
    // substring in 评语.
    const titleRescue = new Map();
    for (const nye of noYearEntries) {
        const commentLower = nye.comment.toLowerCase();
        for (const e of entries) {
            if (titleRescue.has(e.externalId)) continue;
            if (e.title && commentLower.includes(e.title.toLowerCase())) {
                titleRescue.set(e.externalId, nye);
                break;
            }
        }
    }

    const items = [];
    const ambiguous = [];
    let matched = 0, fallback = 0, unresolved = 0;
    for (const e of entries) {
        const candidates = yearMap.get(e.year) ?? [];
        const prevDbid = existing.get(e.externalId);
        let dbid = null;
        let provenance = '';

        if (candidates.length === 1) {
            dbid = candidates[0].dbid;
            provenance = 'doulist (year)';
            matched++;
        } else if (candidates.length >= 2) {
            const byPrev = prevDbid && candidates.find(c => c.dbid === prevDbid);
            const titleLower = e.title.toLowerCase();
            const byTitle = candidates.find(c => c.comment.toLowerCase().includes(titleLower));
            if (byPrev) {
                dbid = byPrev.dbid;
                provenance = `doulist (${candidates.length} candidates, matched via prev snapshot)`;
                matched++;
            } else if (byTitle) {
                dbid = byTitle.dbid;
                provenance = `doulist (${candidates.length} candidates, matched via EN title in comment)`;
                matched++;
            } else {
                ambiguous.push({ entry: e, candidates });
                provenance = 'deferred to Pass 3';
            }
        } else if (titleRescue.has(e.externalId)) {
            dbid = titleRescue.get(e.externalId).dbid;
            provenance = 'doulist (no-year entry, matched via EN title in comment)';
            matched++;
        } else if (prevDbid) {
            dbid = prevDbid;
            provenance = 'fallback (year not in doulist)';
            fallback++;
        } else {
            provenance = 'UNRESOLVED (year not in doulist)';
            unresolved++;
        }
        console.log(`  ${e.externalId}  ${e.title} — ${e.artist}  → ${dbid ?? '—'}  [${provenance}]`);
        items.push({ entry: e, dbid, provenance });
    }

    if (ambiguous.length > 0) {
        console.log(`\nPass 3: resolving ${ambiguous.length} ambiguous year(s) via subject-page 原作名…`);
        const originalTitles = new Map();
        const candidateDbids = new Set();
        for (const a of ambiguous) for (const c of a.candidates) candidateDbids.add(c.dbid);
        const dbidList = [...candidateDbids];
        for (let i = 0; i < dbidList.length; i++) {
            const dbid = dbidList[i];
            process.stdout.write(`  [${i + 1}/${dbidList.length}] ${dbid} → `);
            const orig = await fetchOriginalTitle(dbid);
            if (orig) {
                originalTitles.set(dbid, orig);
                console.log(`原作名="${orig}"`);
            } else {
                console.log('no alt-title field');
            }
            if (i + 1 < dbidList.length) await sleep(DOULIST_DELAY_MS);
        }
        for (const a of ambiguous) {
            const titleLower = a.entry.title.toLowerCase();
            const match = a.candidates.find(c => (originalTitles.get(c.dbid) ?? '').toLowerCase().includes(titleLower));
            const prevDbid = existing.get(a.entry.externalId);
            const item = items.find(it => it.entry.externalId === a.entry.externalId);
            if (match) {
                item.dbid = match.dbid;
                item.provenance = `Pass 3 (subject-page 原作名 matched)`;
                matched++;
            } else if (prevDbid) {
                item.dbid = prevDbid;
                item.provenance = `Pass 3 gave up, kept prev snapshot dbid`;
                fallback++;
            } else {
                item.provenance = `Pass 3 AMBIGUOUS (candidates: ${a.candidates.map(c => `${c.dbid}=${originalTitles.get(c.dbid) ?? '?'}`).join(', ')})`;
                unresolved++;
            }
            console.log(`  ${a.entry.externalId}  ${a.entry.title} → ${item.dbid ?? '—'}  [${item.provenance}]`);
        }
    }

    const finalItems = items.map(it => ({ ...it.entry, ...(it.dbid ? { doubanId: it.dbid } : {}) }));
    const resolved = finalItems.filter(it => it.doubanId).length;
    const payload = {
        generatedAt: new Date().toISOString(),
        source: GRAMMY_AOTY_LIST_URL,
        count: finalItems.length,
        resolvedCount: resolved,
        items: finalItems,
    };
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify(payload, null, 2) + '\n',
        'utf-8',
    );
    console.log(
        `\nWrote ${finalItems.length} entries (${resolved} resolved) to ${SNAPSHOT_PATH}\n` +
            `  matched via doulist: ${matched}\n` +
            `  fallback to previous: ${fallback}\n` +
            `  unresolved: ${unresolved}\n` +
            `Next: git add config/grammy-aoty-snapshot.json && git commit && git push`,
    );
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
