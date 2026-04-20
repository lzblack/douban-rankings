import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source: BBC Culture "The 21st Century's 100 Greatest TV Series" (2021).
 *
 * https://www.bbc.com/culture/article/20210827-the-21st-centurys-100-greatest-tv-series
 *
 * A 2021 survey of 206 TV experts across 43 countries by BBC Culture,
 * ranking the top 100 TV series first aired in or after 2000. More
 * international / critic-weighted than IMDb's popularity-driven Top 250.
 *
 * Pre-resolved snapshot model. The canonical data source is the Douban
 * doulist 146136295 ("BBC 21世纪百大剧集"), which is itself a faithful
 * transcription of the BBC list with Douban subject ids resolved per
 * entry by the doulist curator. The maintainer fetch script scrapes
 * that doulist to produce `config/bbc-21c-tv-100-snapshot.json`; the
 * pipeline reads the snapshot and does zero network work at run time.
 *
 * Fetcher: `pnpm run fetch:bbc-21c-tv-100-snapshot`. Cadence: rarely —
 * BBC hasn't refreshed this list since 2021; maintainer-triggered only.
 */

const DEFAULT_SNAPSHOT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'bbc-21c-tv-100-snapshot.json',
);

/** @typedef {{ externalId: string, rank: number, title: string, doubanId?: string }} ScrapedItem */

export default {
    id: 'bbc-21c-tv-100',
    category: 'movie',
    subCategory: 'tv',
    kind: 'permanent',
    priority: 6,
    externalIdKind: 'pre-resolved',
    meta: {
        title: 'BBC — 21st Century 100 Greatest TV Series',
        titleZh: 'BBC 21 世纪百大剧集',
        url: 'https://www.bbc.com/culture/article/20210827-the-21st-centurys-100-greatest-tv-series',
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
                    'bbc-21c-tv-100: ' +
                        snapshotPath +
                        ' not found. Run `pnpm run fetch:bbc-21c-tv-100-snapshot` from a residential IP and commit the generated file.',
                );
            }
            throw err;
        }
        const data = JSON.parse(raw);
        return Array.isArray(data?.items) ? data.items : [];
    },

    /**
     * Snapshot pre-resolves every dbid; matchItem just returns it.
     * prevResolved cache honored for entries that somehow lost their id.
     *
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} _http
     * @param {{ prevResolved?: Map<string, Map<string, string[]>> }} [ctx]
     */
    async matchItem(raw, _http, ctx = {}) {
        if (raw.doubanId) return [String(raw.doubanId)];
        const cached = ctx.prevResolved?.get('bbc-21c-tv-100')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return [];
    },
};
