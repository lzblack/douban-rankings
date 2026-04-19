import * as cheerio from 'cheerio';
import { matchTitleYearToDouban } from '../matchers/title-year-to-douban.mjs';

/**
 * Source: AFI's 100 Years...100 Movies (10th Anniversary Edition, 2007).
 *
 * The American Film Institute's canon of 100 narrative American
 * features, voted by a jury of 1,500+ artists and critics. Last
 * updated 2007 — treated as `permanent` here.
 *
 * Data comes from the Wikipedia article, whose first wikitable is a
 * clean 1-row-per-film table (Rank / Title / Director / Year / ...).
 * No bot filter, no per-film enrichment needed — Wikipedia responds
 * fine to GitHub Actions runners.
 *
 * Matching is via title + year through `matchTitleYearToDouban`.
 * Since AFI titles are mainstream American classics, PtGen coverage
 * is high; the Douban-search fallback stays enabled (~100 entries
 * means at most a handful of searches per cold start, low-risk).
 */

const LIST_URL =
    'https://en.wikipedia.org/wiki/AFI%27s_100_Years...100_Movies_(10th_Anniversary_Edition)';

/** @typedef {{ externalId: string, rank: number, title: string, year: string }} ScrapedItem */

export default {
    id: 'afi-top100',
    category: 'movie',
    subCategory: 'movie',
    kind: 'permanent',
    priority: 3,
    externalIdKind: 'title-year',
    meta: {
        title: "AFI's 100 Years…100 Movies",
        titleZh: 'AFI 百年百大电影',
        url: 'https://www.afi.com/afis-100-years-100-movies-10th-anniversary-edition/',
    },

    /**
     * @param {{ fetch: Function }} http
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(http) {
        const res = await http.fetch(LIST_URL);
        if (!res.ok) throw new Error(`afi-top100: HTTP ${res.status}`);
        return parseList(await res.text());
    },

    /**
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} http
     * @param {{ prevResolved?: Map<string, Map<string, string[]>> }} [ctx]
     */
    async matchItem(raw, http, ctx = {}) {
        const cached = ctx.prevResolved?.get('afi-top100')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return matchTitleYearToDouban(
            { title: raw.title, year: raw.year },
            http,
            // AFI is mainstream American classics; PtGen hit rate high,
            // Layer 3 fallback catches the remaining handful.
        );
    },
};

/**
 * Parse the Wikipedia wikitable. Exported for tests.
 * Expected columns: Rank | Title | Director | Year | Production | Change
 *
 * @param {string} html
 * @returns {ScrapedItem[]}
 */
export function parseList(html) {
    const $ = cheerio.load(html);
    const table = $('table.wikitable').first();
    if (table.length === 0) {
        throw new Error('afi-top100: first wikitable not found');
    }
    const items = [];
    table.find('tr').each((_, tr) => {
        const cells = $(tr).find('td').toArray();
        if (cells.length < 4) return; // header row or malformed
        const rankText = $(cells[0]).text().trim();
        const rankMatch = rankText.match(/(\d+)/);
        if (!rankMatch) return;
        const rank = Number(rankMatch[1]);
        const title = $(cells[1]).text().trim();
        // Year cell may contain refs like "1941[a]"; strip brackets
        const year = $(cells[3]).text().trim().replace(/\[.*$/, '').trim();
        if (!title || !year) return;
        items.push({
            externalId: `afi-${rank}`,
            rank,
            title,
            year,
        });
    });
    if (items.length === 0) {
        throw new Error('afi-top100: parsed zero rows from wikitable');
    }
    return items;
}
