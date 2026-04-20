import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';

/**
 * Source: Grammy Award for Album of the Year — winners (1959–).
 *
 * Pre-resolved snapshot model, same reasoning as Bangumi / Booker:
 * Douban music search rate-limits Actions runner IPs within minutes,
 * so the maintainer resolves dbids locally via a fetch script, and
 * the pipeline just reads `config/grammy-aoty-snapshot.json`.
 *
 * Wikipedia's Grammy AOTY page spreads winners across per-decade
 * wikitables. The first row of each ceremony year carries the year;
 * nominee rows omit it. parseList keeps only year-bearing rows.
 */

const LIST_URL =
    'https://en.wikipedia.org/wiki/Grammy_Award_for_Album_of_the_Year';

const DEFAULT_SNAPSHOT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'grammy-aoty-snapshot.json',
);

/** @typedef {{ externalId: string, rank: null, title: string, year: string, artist: string, doubanId?: string }} ScrapedItem */

export default {
    id: 'grammy-aoty',
    category: 'music',
    subCategory: 'album',
    kind: 'yearly',
    priority: 1,
    externalIdKind: 'pre-resolved',
    meta: {
        title: 'Grammy Album of the Year — Winners',
        titleZh: '格莱美年度专辑',
        url: 'https://www.grammy.com/awards',
    },
    // Grammy winners aren't ranked; the ceremony year is the natural label
    // (e.g. "2024"). externalId has form "grammy-aoty-YYYY".
    formatLabel: it => {
        const m = String(it.externalId ?? '').match(/(\d{4})$/);
        return m ? m[1] : null;
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
                    'grammy-aoty: ' +
                        snapshotPath +
                        ' not found. Run `pnpm run fetch:grammy-aoty-snapshot` from a residential IP and commit the generated file.',
                );
            }
            throw err;
        }
        const data = JSON.parse(raw);
        return Array.isArray(data?.items) ? data.items : [];
    },

    /**
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} _http
     * @param {{ prevResolved?: Map<string, Map<string, string[]>> }} [ctx]
     */
    async matchItem(raw, _http, ctx = {}) {
        if (raw.doubanId) return [String(raw.doubanId)];
        const cached = ctx.prevResolved?.get('grammy-aoty')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return [];
    },
};

/**
 * Parse the Wikipedia Grammy AOTY page. Walks every wikitable;
 * keeps only rows whose first cell starts with a 4-digit year
 * (= the ceremony's winning album row). Exported for the fetch script.
 *
 * @param {string} html
 * @returns {Array<{ externalId: string, rank: null, title: string, year: string, artist: string }>}
 */
export function parseList(html) {
    const $ = cheerio.load(html);
    const items = [];
    $('table.wikitable').each((_, table) => {
        $(table)
            .find('tr')
            .each((_, tr) => {
                const allCells = $(tr).find('th,td').toArray();
                if (allCells.length < 3) return;
                const yearText = cleanCell($(allCells[0]).text());
                const yearMatch = yearText.match(/^(\d{4})/);
                if (!yearMatch) return;
                const year = yearMatch[1];
                const title = cleanCell($(allCells[1]).text());
                const artist = cleanCell($(allCells[2]).text());
                if (!title || !artist) return;
                items.push({
                    externalId: `grammy-aoty-${year}`,
                    rank: null,
                    title,
                    year,
                    artist,
                });
            });
    });
    if (items.length === 0) {
        throw new Error('grammy-aoty: parsed zero winners');
    }
    return items;
}

function cleanCell(t) {
    return String(t)
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

export { LIST_URL as GRAMMY_AOTY_LIST_URL };
