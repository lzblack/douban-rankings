import * as cheerio from 'cheerio';

const IMDB_TOP250_URL = 'https://www.imdb.com/chart/top';

/**
 * @typedef {{ externalId: string, rank: number, title: string }} ScrapedItem
 */

export default {
    id: 'imdb-top250',
    category: 'movie',
    subCategory: 'movie',
    kind: 'permanent',
    priority: 1,
    externalIdKind: 'imdb',
    meta: {
        title: 'IMDb Top 250',
        titleZh: 'IMDb 250 佳片',
        url: IMDB_TOP250_URL,
    },

    /**
     * @param {{ fetch: (url: string, init?: RequestInit) => Promise<Response> }} http
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(http) {
        const res = await http.fetch(IMDB_TOP250_URL);
        if (!res.ok) throw new Error(`imdb-top250: HTTP ${res.status}`);
        return parseImdbTop250(await res.text());
    },
};

/**
 * Parse the IMDB Top 250 chart page. Prefers the ItemList JSON-LD
 * because IMDB maintains it for schema.org consumers — it's more
 * stable than visual DOM selectors across site redesigns.
 *
 * Exported for testing.
 *
 * @param {string} html
 * @returns {ScrapedItem[]}
 */
export function parseImdbTop250(html) {
    const $ = cheerio.load(html);
    const itemList = $('script[type="application/ld+json"]')
        .toArray()
        .map(el => {
            try {
                return JSON.parse($(el).text());
            } catch {
                return null;
            }
        })
        .filter(Boolean)
        .find(
            d => d['@type'] === 'ItemList' && Array.isArray(d.itemListElement),
        );

    if (!itemList) {
        throw new Error('imdb-top250: ItemList JSON-LD not found on page');
    }

    const items = [];
    for (const el of itemList.itemListElement) {
        const movie = el.item ?? el;
        const m = movie?.url?.match(/\/title\/(tt\d+)/);
        if (!m || el.position == null) continue;
        items.push({
            externalId: m[1],
            rank: el.position,
            title: movie.name ?? '',
        });
    }
    return items;
}
