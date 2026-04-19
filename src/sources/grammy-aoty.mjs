import * as cheerio from 'cheerio';
import { matchMusicToDouban } from '../matchers/music-to-douban.mjs';

/**
 * Source: Grammy Award for Album of the Year — winners (1959–).
 *
 * The most prominent American music prize; ~65 annual winners, stable
 * once awarded. Wikipedia lists them across per-decade wikitables
 * (1950s / 1960s / 1970s / 1980s / ...); the "winner" row of each
 * ceremony year has the year in the first cell, followed by nominee
 * rows that omit the year. We keep only the year-bearing rows.
 */

const LIST_URL =
    'https://en.wikipedia.org/wiki/Grammy_Award_for_Album_of_the_Year';

/** @typedef {{ externalId: string, rank: null, title: string, year: string, artist: string }} ScrapedItem */

export default {
    id: 'grammy-aoty',
    category: 'music',
    subCategory: 'album',
    kind: 'yearly',
    priority: 1,
    externalIdKind: 'music-title',
    meta: {
        title: 'Grammy Album of the Year — Winners',
        titleZh: '格莱美年度专辑',
        url: 'https://www.grammy.com/awards',
    },

    /**
     * @param {{ fetch: Function }} http
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(http) {
        const res = await http.fetch(LIST_URL);
        if (!res.ok) throw new Error(`grammy-aoty: HTTP ${res.status}`);
        return parseList(await res.text());
    },

    /**
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} http
     * @param {{ prevResolved?: Map<string, Map<string, string[]>> }} [ctx]
     */
    async matchItem(raw, http, ctx = {}) {
        const cached = ctx.prevResolved?.get('grammy-aoty')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return matchMusicToDouban(
            { title: raw.title, artist: raw.artist },
            http,
        );
    },
};

/**
 * Parse every `<table class="wikitable">` on the page, keeping only
 * rows whose first cell starts with a 4-digit year (winner row per
 * ceremony). Exported for tests.
 *
 * @param {string} html
 * @returns {ScrapedItem[]}
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
