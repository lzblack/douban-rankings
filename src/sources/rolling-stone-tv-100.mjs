import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source: Rolling Stone "The 100 Greatest TV Shows of All Time" (2022).
 *
 * https://www.rollingstone.com/tv-movies/tv-movie-lists/best-tv-shows-of-all-time-1234598313/
 *
 * September 2022 revision. Rolling Stone's editorial all-time list;
 * US critical perspective, heavier on cable-golden-age drama than
 * BBC Culture's international 21st-century list — the two make good
 * complements.
 *
 * Pre-resolved snapshot model via Douban doulist 152291659 ("滚石杂志
 * 评选历史上最伟大的100部电视节目"). Rank per entry is encoded in the
 * 评语 comment ("评语：No.100" / sometimes "N0.100"); the fetcher
 * parses it out and renumbers.
 */

const DEFAULT_SNAPSHOT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'rolling-stone-tv-100-snapshot.json',
);

/** @typedef {{ externalId: string, rank: number, title: string, doubanId?: string }} ScrapedItem */

export default {
    id: 'rolling-stone-tv-100',
    category: 'movie',
    subCategory: 'tv',
    kind: 'permanent',
    priority: 5,
    externalIdKind: 'pre-resolved',
    meta: {
        title: 'Rolling Stone — 100 Greatest TV Shows of All Time',
        titleZh: '滚石 100 最伟大电视剧',
        url: 'https://www.rollingstone.com/tv-movies/tv-movie-lists/best-tv-shows-of-all-time-1234598313/',
    },
    formatLabel: it => (it.rank == null ? null : `No.${it.rank}`),

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
                    'rolling-stone-tv-100: ' +
                        snapshotPath +
                        ' not found. Run `pnpm run fetch:rolling-stone-tv-100-snapshot` from a residential IP and commit the generated file.',
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
        const cached = ctx.prevResolved?.get('rolling-stone-tv-100')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return [];
    },
};
