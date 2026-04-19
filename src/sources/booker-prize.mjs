import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

/**
 * Source: The Booker Prize — winners (1969–).
 *
 * Annual award for the best English-language novel; ~60 winners as of
 * 2025. Wikipedia lists them in a single wikitable (columns: Year,
 * Author, Title, Genre, Country).
 *
 * Pre-resolved snapshot pattern (same as Bangumi Top 250):
 *
 *   - Pipeline's matchBookToDouban hits search.douban.com/book/
 *     subject_search, which rate-limits Actions runner IPs quickly
 *     (observed 0/57 matched on the first run).
 *   - Fetcher `scripts/fetch-booker-prize-snapshot.mjs` scrapes
 *     Wikipedia + resolves each winner's Douban book subject id
 *     locally on a residential IP at polite pacing, then writes
 *     `config/booker-prize-snapshot.json`.
 *   - Pipeline scrape() reads that snapshot; matchItem returns the
 *     pre-resolved [doubanId] with zero remote calls.
 *
 * Cadence: annual (one new winner/year). Re-run the fetcher each
 * November after the winner announcement.
 */

const LIST_URL = 'https://en.wikipedia.org/wiki/Booker_Prize';

const DEFAULT_SNAPSHOT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'booker-prize-snapshot.json',
);

/** @typedef {{ externalId: string, rank: null, title: string, year: string, author: string, doubanId?: string }} ScrapedItem */

export default {
    id: 'booker-prize',
    category: 'book',
    subCategory: 'book',
    kind: 'yearly',
    priority: 1,
    externalIdKind: 'pre-resolved',
    meta: {
        title: 'The Booker Prize — Winners',
        titleZh: '布克奖历届得主',
        url: 'https://thebookerprizes.com/the-booker-library',
    },

    /**
     * @param {{ fetch: Function }} _http
     * @param {{ snapshotPath?: string }} [opts]
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(_http, opts = {}) {
        const snapshotPath = opts.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
        let raw;
        try {
            raw = await readFile(snapshotPath, 'utf-8');
        } catch (err) {
            if (err.code === 'ENOENT') {
                throw new Error(
                    'booker-prize: ' +
                        snapshotPath +
                        ' not found. Run `pnpm run fetch:booker-prize-snapshot` from a residential IP and commit the generated file.',
                );
            }
            throw err;
        }
        const data = JSON.parse(raw);
        return Array.isArray(data?.items) ? data.items : [];
    },

    /**
     * Snapshot pre-resolves doubanId; matchItem just returns it.
     * prevResolved cache honored as a secondary fallback.
     *
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} _http
     * @param {{ prevResolved?: Map<string, Map<string, string[]>> }} [ctx]
     */
    async matchItem(raw, _http, ctx = {}) {
        if (raw.doubanId) return [String(raw.doubanId)];
        const cached = ctx.prevResolved?.get('booker-prize')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return [];
    },
};

/**
 * Parse the Booker Prize Wikipedia page's first wikitable into
 * winners. Exported for the fetch script.
 *
 * @param {string} html
 * @returns {Array<{ externalId: string, rank: null, title: string, year: string, author: string }>}
 */
export function parseList(html) {
    const $ = cheerio.load(html);
    const table = $('table.wikitable').first();
    if (table.length === 0) {
        throw new Error('booker-prize: first wikitable not found');
    }
    const items = [];
    table.find('tr').each((_, tr) => {
        const allCells = $(tr).find('th,td').toArray();
        if (allCells.length < 3) return;
        const yearText = $(allCells[0]).text().trim();
        const yearMatch = yearText.match(/(\d{4})/);
        if (!yearMatch) return;
        const year = yearMatch[1];
        const author = cleanCell($(allCells[1]).text());
        const title = cleanCell($(allCells[2]).text());
        if (!title || !author) return;
        items.push({
            externalId: `booker-${year}`,
            rank: null,
            title,
            year,
            author,
        });
    });
    if (items.length === 0) {
        throw new Error('booker-prize: parsed zero rows');
    }
    return items;
}

function cleanCell(t) {
    return String(t)
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export { LIST_URL as BOOKER_LIST_URL };
