import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchImdbToDouban } from '../matchers/imdb-to-douban.mjs';

/**
 * Source: They Shoot Pictures, Don't They? — 1,000 Greatest Films.
 *
 * TSPDT is a meta-list compiled from 17,000+ critic & professional
 * ballots, widely considered the definitive art-film canon. Updated
 * yearly (21st edition published 2026-01-01).
 *
 * Scope note: this is a 1000-entry list — much broader than our other
 * sources' 100-250. Consumer may choose to display rank only for top
 * tiers and fall back to a plain "TSPDT 1000" badge for higher ranks,
 * where rank precision matters less than the pass/fail signal.
 *
 * Snapshot-first: the TSPDT website itself is an aging Rapidweaver
 * shell where the list renders from sub-pages/images, not clean HTML.
 * We instead use the Letterboxd mirror maintained by user `thisisdrew`
 * (he reliably updates it with each new TSPDT edition), fetching the
 * per-film IMDb tt from each /film/<slug>/ page.
 */

const DEFAULT_SNAPSHOT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'tspdt-1000-snapshot.json',
);

/** @typedef {{ externalId: string, rank: number, tt: string, title: string, year: string, slug?: string }} ScrapedItem */

export default {
    id: 'tspdt-1000',
    category: 'movie',
    subCategory: 'movie',
    kind: 'yearly',
    priority: 6,
    externalIdKind: 'imdb',
    meta: {
        title: "TSPDT — 1,000 Greatest Films",
        titleZh: 'TSPDT 影史千部',
        url: 'https://theyshootpictures.com/gf1000_all1000films.htm',
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
                    'tspdt-1000: ' +
                        snapshotPath +
                        ' not found (snapshots are gitignored — refresh is maintainer-local: pnpm run fetch:tspdt-1000-snapshot).',
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
        const cached = ctx.prevResolved?.get('tspdt-1000')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return matchImdbToDouban(raw.externalId, http);
    },
};
