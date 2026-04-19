import * as cheerio from 'cheerio';
import { matchBookToDouban } from '../matchers/book-to-douban.mjs';

/**
 * Source: The Booker Prize — winners (1969–).
 *
 * Annual award for the best English-language novel; the winner list
 * is one of the most stable literary canons we can ship. ~60 winners
 * as of 2025, Wikipedia has them in a single wikitable.
 *
 * Category: `book`. Douban hosts books at `book.douban.com/subject/*`
 * (distinct URL pattern from movies), so output lives in `book.json`.
 */

const LIST_URL = 'https://en.wikipedia.org/wiki/Booker_Prize';

/** @typedef {{ externalId: string, rank: null, title: string, year: string, author: string }} ScrapedItem */

export default {
    id: 'booker-prize',
    category: 'book',
    subCategory: 'book',
    kind: 'yearly',
    priority: 1,
    externalIdKind: 'book-title',
    meta: {
        title: 'The Booker Prize — Winners',
        titleZh: '布克奖历届得主',
        url: 'https://thebookerprizes.com/the-booker-library',
    },

    /**
     * @param {{ fetch: Function }} http
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(http) {
        const res = await http.fetch(LIST_URL);
        if (!res.ok) throw new Error(`booker-prize: HTTP ${res.status}`);
        return parseList(await res.text());
    },

    /**
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} http
     * @param {{ prevResolved?: Map<string, Map<string, string[]>> }} [ctx]
     */
    async matchItem(raw, http, ctx = {}) {
        const cached = ctx.prevResolved?.get('booker-prize')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return matchBookToDouban(
            { title: raw.title, author: raw.author, year: raw.year },
            http,
        );
    },
};

/**
 * Parse the Booker Prize Wikipedia page's first wikitable into winners.
 * Columns: Year | Author | Title | Genre(s) | Country. Exported for tests.
 *
 * @param {string} html
 * @returns {ScrapedItem[]}
 */
export function parseList(html) {
    const $ = cheerio.load(html);
    const table = $('table.wikitable').first();
    if (table.length === 0) {
        throw new Error('booker-prize: first wikitable not found');
    }
    const items = [];
    table.find('tr').each((_, tr) => {
        const cells = $(tr).find('td').toArray();
        if (cells.length < 3) return; // header or malformed
        // Year cell may wrap in <th> sometimes; re-query cells to include th
        const allCells = $(tr).find('th,td').toArray();
        const yearText = $(allCells[0]).text().trim();
        const yearMatch = yearText.match(/(\d{4})/);
        if (!yearMatch) return;
        const year = yearMatch[1];
        const author = cleanCell($(allCells[1]).text());
        const title = cleanCell($(allCells[2]).text());
        if (!title || !author) return;
        items.push({
            // Year is unique per winner (at most one winner per year);
            // compound externalId is stable and human-inspectable.
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
        .replace(/\[[^\]]*\]/g, '') // strip wiki footnote markers like [64]
        .replace(/\s+/g, ' ')
        .trim();
}
