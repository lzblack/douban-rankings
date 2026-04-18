import * as cheerio from 'cheerio';
import { matchTitleYearToDouban } from '../matchers/title-year-to-douban.mjs';

/**
 * Source: The Criterion Collection.
 *
 * Criterion's browse/list page server-renders the entire Collection
 * (~1800 titles) in one HTML response. Each row has the spine number,
 * title, director, country, and release year — but NOT the IMDB id,
 * so we can't use the imdb matcher directly.
 *
 * Matching is done by `matchTitleYearToDouban` with
 * `skipSearchFallback: true` — two layers only:
 *   manual-mapping.titles → IMDB datasets title+year → PtGen → douban
 *
 * We deliberately skip the Douban search fallback because Criterion is
 * ~1800 entries, and 15-20% miss rate would have meant hundreds of
 * rate-limited search hits on every cold start. Instead those misses
 * go straight to the unresolved log for patient manual-mapping
 * curation. Monthly cron stays seconds-fast; coverage converges over
 * time as maintainers triage unresolved entries.
 *
 * ctx.prevResolved lets us skip even the PtGen lookup on entries we
 * resolved in a prior run — only new spines incur work.
 */

const LIST_URL = 'https://www.criterion.com/shop/browse/list';

/** @typedef {{ externalId: string, rank: null, title: string, year: string, slug?: string }} ScrapedItem */

export default {
    id: 'criterion',
    category: 'movie',
    subCategory: 'movie',
    kind: 'permanent',
    priority: 2,
    externalIdKind: 'title-year',
    meta: {
        title: 'The Criterion Collection',
        titleZh: '标准收藏',
        url: LIST_URL,
    },

    /**
     * @param {{ fetch: Function }} http
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(http) {
        // criterion.com blocks cloud-provider IPs at the edge (403 from
        // GitHub Actions runners, 200 from residential IPs). Sending a
        // fuller browser signature header set is a cheap mitigation
        // before resorting to snapshot-via-local-fetch.
        const res = await http.fetch(LIST_URL, {
            headers: {
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Upgrade-Insecure-Requests': '1',
            },
        });
        if (!res.ok) throw new Error(`criterion: HTTP ${res.status}`);
        return parseList(await res.text());
    },

    /**
     * Item-level matcher that respects ctx.prevResolved so monthly
     * runs don't re-query Douban for entries we already know.
     *
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} http
     * @param {{ prevResolved?: Map<string, Map<string, string>> }} [ctx]
     */
    async matchItem(raw, http, ctx = {}) {
        const cached = ctx.prevResolved?.get('criterion')?.get(raw.externalId);
        if (cached) return cached;
        return matchTitleYearToDouban(
            { title: raw.title, year: raw.year },
            http,
            { skipSearchFallback: true },
        );
    },
};

/**
 * Parse the browse/list HTML into ScrapedItem[]. Exported for tests.
 * Uses `<tr class="gridFilm">` rows (one per film), falling back
 * gracefully when a cell is missing.
 *
 * @param {string} html
 * @returns {ScrapedItem[]}
 */
export function parseList(html) {
    const $ = cheerio.load(html);
    const rows = $('tr.gridFilm').toArray();
    const items = [];
    for (const tr of rows) {
        const $tr = $(tr);
        const spine = $tr.find('.g-spine').text().trim();
        const title = $tr.find('.g-title span').text().trim()
            || $tr.find('.g-title').text().trim();
        const year = $tr.find('.g-year').text().trim();
        if (!spine || !title) continue;
        const href = $tr.attr('data-href') ?? '';
        const slugMatch = href.match(/\/films\/\d+-([^/?#]+)/);
        items.push({
            externalId: spine,      // spine number uniquely identifies a CC entry
            rank: null,             // Criterion isn't ranked
            title,
            year,
            slug: slugMatch?.[1],
        });
    }
    return items;
}
