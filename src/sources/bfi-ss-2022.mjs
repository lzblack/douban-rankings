import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchImdbToDouban } from '../matchers/imdb-to-douban.mjs';

/**
 * Source: BFI Sight & Sound 2022 Critics' Poll — Greatest Films of All
 * Time. Decadal poll of 1,639 critics, curators, and academics;
 * treated as `permanent` until the next edition (~2032).
 *
 * Snapshot-first, same architecture as Criterion:
 *   1. Maintainer runs `pnpm run fetch:bfi-ss-snapshot` from a
 *      residential IP. The script scrapes Letterboxd's bfi list
 *      (100 films) + enriches each with IMDb tt from the film page.
 *   2. Result is committed as `config/bfi-ss-snapshot.json`.
 *   3. Pipeline's scrape() reads the snapshot, zero network in CI.
 *
 * Why snapshot-first:
 *   - The BFI official list page is a React client-side render — no
 *     full list in the HTML shell.
 *   - Wikipedia only lists top 20-40 in `<ol>` blocks.
 *   - Letterboxd has the full 100 but per-film enrichment needs 100
 *     additional page fetches, better done offline and cached.
 *
 * Matcher: IMDB tt → Douban (via matchImdbToDouban). Snapshot already
 * carries tt, so PtGen reverse map is the fast path.
 */

const DEFAULT_SNAPSHOT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'bfi-ss-snapshot.json',
);

/** @typedef {{ externalId: string, rank: number, tt: string, title: string, year: string, slug?: string }} ScrapedItem */

export default {
    id: 'bfi-ss-2022',
    category: 'movie',
    subCategory: 'movie',
    kind: 'permanent',
    priority: 4,
    externalIdKind: 'imdb',
    meta: {
        title: 'Sight & Sound Greatest Films of All Time (2022)',
        titleZh: '视与听 影史百大（2022）',
        url: 'https://www.bfi.org.uk/sight-and-sound/greatest-films-all-time',
    },

    /**
     * Read the maintainer-curated snapshot. http param is unused —
     * no network at scrape time.
     *
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
                    'bfi-ss-2022: ' +
                        snapshotPath +
                        ' not found. Run `pnpm run fetch:bfi-ss-snapshot` from a residential IP and commit the generated file.',
                );
            }
            throw err;
        }
        const data = JSON.parse(raw);
        const items = Array.isArray(data?.items) ? data.items : [];
        // Ensure each item exposes externalId = tt id for the imdb matcher
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
        const cached = ctx.prevResolved?.get('bfi-ss-2022')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return matchImdbToDouban(raw.externalId, http);
    },
};
