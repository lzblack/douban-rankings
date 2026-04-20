#!/usr/bin/env node
/**
 * Maintainer utility: build `config/rolling-stone-tv-100-snapshot.json`.
 *
 * Canonical data source is Douban doulist 152291659, a transcription
 * of Rolling Stone's 2022 "100 Greatest TV Shows of All Time" with
 * dbids resolved per entry. Rank is encoded in the 评语 as
 * "评语：No.<N>" (occasionally typo'd "N0.<N>"); the doulist is sorted
 * pos=1 → No.100 (reverse-rank order).
 *
 * Re-run cadence: ad-hoc. Rolling Stone may publish revisions every
 * few years; re-run after any new version.
 *
 *   pnpm run fetch:rolling-stone-tv-100-snapshot
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetchViaCurl } from './lib/doulist.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'rolling-stone-tv-100-snapshot.json');

const DOULIST_ID = '152291659';
const DOULIST_DELAY_MS = 3000;
const DOULIST_URL = `https://www.douban.com/doulist/${DOULIST_ID}/`;
const RS_ARTICLE_URL =
    'https://www.rollingstone.com/tv-movies/tv-movie-lists/best-tv-shows-of-all-time-1234598313/';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function scrapeRsDoulist(doulistId) {
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
            const comment = $el.find('.ft blockquote.comment').text().replace(/\s+/g, ' ').trim();
            // Rank in 评语: "No.NN" but curator typos some as "N0.NN".
            const rankMatch = comment.match(/N[0o]\.(\d+)/i);
            if (!rankMatch) continue;
            const rank = Number(rankMatch[1]);
            if (!Number.isFinite(rank)) continue;
            if (title && dbid) entries.push({ rank, title, dbid });
        }
        start += 25;
        await sleep(DOULIST_DELAY_MS);
    }
    return entries;
}

async function main() {
    console.log(`Scraping doulist ${DOULIST_ID}…`);
    const entries = await scrapeRsDoulist(DOULIST_ID);
    console.log(`Collected ${entries.length} ranked entries`);

    entries.sort((a, b) => a.rank - b.rank);

    const presentRanks = new Set(entries.map(e => e.rank));
    const gaps = [];
    for (let r = 1; r <= 100; r++) if (!presentRanks.has(r)) gaps.push(r);
    if (gaps.length > 0) {
        console.warn(`Doulist has gaps at ranks: ${gaps.join(', ')} — curator likely removed those entries; resolve by hand if needed.`);
    }

    const items = entries.map(e => ({
        externalId: `rs-tv-${e.rank}`,
        rank: e.rank,
        title: e.title,
        doubanId: e.dbid,
    }));

    const payload = {
        generatedAt: new Date().toISOString(),
        source: RS_ARTICLE_URL,
        doulistSource: DOULIST_URL,
        count: items.length,
        resolvedCount: items.filter(it => it.doubanId).length,
        items,
    };
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify(payload, null, 2) + '\n',
        'utf-8',
    );
    console.log(
        `\nWrote ${items.length} entries to ${SNAPSHOT_PATH}\n` +
            `Next: git add config/rolling-stone-tv-100-snapshot.json && git commit && git push`,
    );
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
