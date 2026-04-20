#!/usr/bin/env node
/**
 * Maintainer utility: build `config/bbc-21c-tv-100-snapshot.json`.
 *
 * The canonical data source is Douban doulist 146136295, which is a
 * faithful transcription of BBC Culture's 2021 "21st Century's 100
 * Greatest TV Series" ranking with dbids already resolved per entry.
 *
 * Scrape = 4 doulist pages = ~12 s. No matching layer needed: the
 * curator's rank (hd.pos) and dbid (subject URL) are both first-class
 * fields in the doulist HTML.
 *
 * Re-run cadence: ad-hoc. BBC hasn't refreshed the list since 2021; the
 * only reason to re-fetch is if the doulist curator has corrected an
 * entry.
 *
 *   pnpm run fetch:bbc-21c-tv-100-snapshot
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { fetchViaCurl } from './lib/doulist.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'bbc-21c-tv-100-snapshot.json');

const DOULIST_ID = '146136295';
const DOULIST_DELAY_MS = 3000;
const DOULIST_URL = `https://www.douban.com/doulist/${DOULIST_ID}/`;
const BBC_ARTICLE_URL =
    'https://www.bbc.com/culture/article/20210827-the-21st-centurys-100-greatest-tv-series';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * The shared doulist helper pulls year from 评语; here we need the
 * per-entry rank from .hd.pos instead, so iterate pages inline rather
 * than via scrapeDoulistAll.
 */
async function scrapeRankedDoulist(doulistId) {
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
            const posText = $el.find('.hd .pos').text().trim();
            const rank = Number(posText);
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
    const entries = await scrapeRankedDoulist(DOULIST_ID);
    console.log(`Collected ${entries.length} ranked entries`);

    entries.sort((a, b) => a.rank - b.rank);

    // Report gaps in 1..100. Empty-title/empty-href slots in the doulist
    // (entries the curator deleted but whose rank markers remain) become
    // missing ranks here; a maintainer can backfill via manual-mapping.
    const presentRanks = new Set(entries.map(e => e.rank));
    const gaps = [];
    for (let r = 1; r <= 100; r++) if (!presentRanks.has(r)) gaps.push(r);
    if (gaps.length > 0) {
        console.warn(`Doulist has gaps at ranks: ${gaps.join(', ')} — curator likely removed those entries; resolve by hand if needed.`);
    }

    const items = entries.map(e => ({
        externalId: `bbc-21c-tv-${e.rank}`,
        rank: e.rank,
        title: e.title,
        doubanId: e.dbid,
    }));

    const payload = {
        generatedAt: new Date().toISOString(),
        source: BBC_ARTICLE_URL,
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
            `Next: git add config/bbc-21c-tv-100-snapshot.json && git commit && git push`,
    );
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
