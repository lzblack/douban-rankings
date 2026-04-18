import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cheerio from 'cheerio';
import { matchTitleYearToDouban } from '../matchers/title-year-to-douban.mjs';

/**
 * Source: The Criterion Collection.
 *
 * criterion.com serves a full server-rendered list at /shop/browse/list
 * from residential IPs but edge-filters cloud-provider IPs to HTTP 403
 * (Azure, AWS, etc. — GitHub Actions runners all fail). Instead of
 * piping through a proxy or giving up, we treat the list as a
 * maintainer-refreshed snapshot:
 *
 *   1. Maintainer runs `pnpm run fetch:criterion-snapshot` on a
 *      residential IP, which fetches, parses, and writes to
 *      `config/criterion-snapshot.json`.
 *   2. That file is committed to the repo.
 *   3. Pipeline's scrape() reads the snapshot file — no network at run
 *      time, deterministic, works fine in CI.
 *
 * Snapshot cadence: ad-hoc. Criterion adds ~5-10 spines per month;
 * refreshing the snapshot quarterly is plenty.
 *
 * Matching is still via `matchTitleYearToDouban` with
 * `skipSearchFallback: true` (layers: manual-mapping → IMDB datasets
 * title-year → PtGen). Unresolved entries go to the log for manual
 * triage into config/manual-mapping.yaml.
 *
 * ctx.prevResolved lets us skip even the PtGen lookup for entries
 * resolved in a prior run.
 */

const LIST_URL = 'https://www.criterion.com/shop/browse/list';

const DEFAULT_SNAPSHOT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'criterion-snapshot.json',
);

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
     * Read the maintainer-curated snapshot. The `http` param is
     * accepted for contract consistency but unused — no network at
     * scrape time.
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
                    'criterion: ' +
                        snapshotPath +
                        ' not found. criterion.com blocks cloud IPs, so the pipeline cannot fetch directly. Run `pnpm run fetch:criterion-snapshot` from a residential IP and commit the generated file.',
                );
            }
            throw err;
        }
        const data = JSON.parse(raw);
        return Array.isArray(data?.items) ? data.items : [];
    },

    /**
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
 * Parse the browse/list HTML into ScrapedItem[]. Exported for tests
 * and used by `scripts/fetch-criterion-snapshot.mjs`.
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
        const title =
            $tr.find('.g-title span').text().trim() ||
            $tr.find('.g-title').text().trim();
        const year = $tr.find('.g-year').text().trim();
        if (!spine || !title) continue;
        const href = $tr.attr('data-href') ?? '';
        const slugMatch = href.match(/\/films\/\d+-([^/?#]+)/);
        items.push({
            externalId: spine,
            rank: null,
            title,
            year,
            slug: slugMatch?.[1],
        });
    }
    return items;
}

export { LIST_URL as CRITERION_LIST_URL };
