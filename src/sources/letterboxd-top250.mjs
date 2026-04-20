import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchImdbToDouban } from '../matchers/imdb-to-douban.mjs';

/**
 * Source: Letterboxd Top 250 Films (Most Fans).
 *
 * Curated by Letterboxd's official account — the 250 films with the
 * most user "fan" bookmarks on the platform. Popularity-based, so
 * complements IMDb Top 250 (which is rating-driven) and BFI SS
 * (critic-voted).
 *
 * Snapshot-first, same architecture as Criterion and BFI SS:
 *   - Maintainer runs `pnpm run fetch:letterboxd-top250-snapshot`
 *     from a residential IP. Script scrapes all 3 pages (100 + 100
 *     + 50) and enriches each film with IMDb tt from the film page.
 *   - Committed snapshot lives at config/letterboxd-top250-snapshot.json
 *   - Pipeline reads snapshot; no network during workflow run.
 */

const DEFAULT_SNAPSHOT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'letterboxd-top250-snapshot.json',
);

/** @typedef {{ externalId: string, rank: number, tt: string, title: string, year: string, slug?: string }} ScrapedItem */

export default {
    id: 'letterboxd-top250',
    category: 'movie',
    subCategory: 'movie',
    kind: 'permanent',
    priority: 5,
    externalIdKind: 'imdb',
    meta: {
        title: 'Letterboxd Top 250 Films (Most Fans)',
        titleZh: 'Letterboxd 人气 250',
        url: 'https://letterboxd.com/official/list/top-250-films-with-the-most-fans/',
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
                const e = new Error(
                    'letterboxd-top250: ' +
                        snapshotPath +
                        ' not found (snapshots are gitignored — refresh is maintainer-local: pnpm run fetch:letterboxd-top250-snapshot).',
                );
                e.code = 'SNAPSHOT_MISSING';
                throw e;
            }
            throw err;
        }
        const data = JSON.parse(raw);
        const items = Array.isArray(data?.items) ? data.items : [];
        return items.map(it => ({
            ...it,
            externalId: it.tt ?? it.externalId,
        }));
    },

    /**
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} http
     * @param {{ prevResolved?: Map<string, Map<string, string[]>> }} [ctx]
     */
    async matchItem(raw, http, ctx = {}) {
        const cached = ctx.prevResolved?.get('letterboxd-top250')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return matchImdbToDouban(raw.externalId, http);
    },
};
