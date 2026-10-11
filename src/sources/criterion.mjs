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
// criterion.com serves a Cloudflare challenge to every non-residential IP
// (CI runners included), so the snapshot fetcher reads the canonical spine
// list from Wikipedia instead; spine numbers are the same, so the
// prevResolved cache keyed on them keeps working.
const WIKIPEDIA_LIST_URL =
    'https://en.wikipedia.org/wiki/List_of_films_in_the_Criterion_Collection';

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
    // health marks the snapshot stale past this age (quarterly refresh).
    snapshotMaxAgeDays: 100,
    priority: 2,
    externalIdKind: 'title-year',
    meta: {
        title: 'The Criterion Collection',
        titleZh: 'CC 标准收藏',
        url: LIST_URL,
    },
    // CC uses spine numbers (`#482`, `#1132`) as the conventional label.
    formatLabel: it => {
        const n = it.spineNumber ?? it.externalId;
        return n ? `#${n}` : null;
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
                const e = new Error(
                    'criterion: ' +
                        snapshotPath +
                        ' not found (generate it with: pnpm run fetch:criterion-snapshot; until then the published items are carried forward).',
                );
                e.code = 'SNAPSHOT_MISSING';
                throw e;
            }
            throw err;
        }
        const data = JSON.parse(raw);
        const items = Array.isArray(data?.items) ? data.items : [];
        // Back-compat: older snapshot files wrote only externalId. Infer
        // spineNumber from externalId so downstream entries carry the
        // CC-semantic field without requiring a snapshot regen.
        return items.map(it => ({
            ...it,
            spineNumber: it.spineNumber ?? it.externalId,
        }));
    },

    /**
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} http
     * @param {{ prevResolved?: Map<string, Map<string, string>> }} [ctx]
     */
    async matchItem(raw, http, ctx = {}) {
        const cached = ctx.prevResolved?.get('criterion')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        const matched = await matchTitleYearToDouban(
            { title: raw.title, year: raw.year },
            http,
            { skipSearchFallback: true },
        );
        if (matched.length > 0) return matched;
        // Final fallback: the curator-picked dbid from the Douban CC doulist
        // (pre-resolved by `scripts/fetch-criterion-snapshot.mjs`). This only
        // kicks in for entries the manual/IMDB/PtGen layers can't resolve,
        // so it strictly expands coverage without reshuffling prior mappings.
        if (raw.doubanId) return [String(raw.doubanId)];
        return [];
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
            // spineNumber is the CC-semantic duplicate of externalId per
            // docs/consumer-integration.md contract: consumer code can
            // read .spineNumber without caring whether the source uses
            // tt id / spine / ISBN as externalId.
            spineNumber: spine,
            title,
            year,
            slug: slugMatch?.[1],
        });
    }
    return items;
}

/**
 * Parse the Wikipedia "List of films in the Criterion Collection" page into
 * ScrapedItem[]. Reads every table that has a film-level spine column
 * ("Spine" for individual releases, "Spine number (of film)" in box-set
 * tables); the Eclipse table has its own numbering and no such column, so it
 * is skipped. When a box set's films have no spine of their own (N/A), the
 * set itself is the release: its spine and name, with the first film's year.
 * The first row wins when a spine appears twice.
 *
 * @param {string} html
 * @returns {ScrapedItem[]}
 */
export function parseWikipediaList(html) {
    const $ = cheerio.load(html);
    const items = [];
    const seen = new Set();
    let spineTables = 0;
    $('table.wikitable').each((_, table) => {
        const [header, ...rows] = expandTable($, table);
        if (!header) return;
        const col = name => header.findIndex(h => h === name);
        const spineCol =
            col('spine number (of film)') >= 0
                ? col('spine number (of film)')
                : col('spine');
        const titleCol =
            col('included films') >= 0 ? col('included films') : col('film');
        const yearCol = header.findIndex(h => h.includes('year'));
        if (spineCol < 0 || titleCol < 0 || yearCol < 0) return;
        const boxSpineCol =
            col('spine number (of film)') >= 0 ? col('spine') : -1;
        const boxNameCol = col('name of box set');
        spineTables++;
        for (const row of rows) {
            let spine = row[spineCol] ?? '';
            let title = row[titleCol] ?? '';
            if (!/^\d+$/.test(spine) && boxSpineCol >= 0 && boxNameCol >= 0) {
                spine = row[boxSpineCol] ?? '';
                title = row[boxNameCol] ?? '';
            }
            if (!/^\d+$/.test(spine) || !title || seen.has(spine)) continue;
            seen.add(spine);
            items.push({
                externalId: spine,
                rank: null,
                spineNumber: spine,
                title,
                year: (row[yearCol] ?? '').match(/\d{4}/)?.[0] ?? '',
            });
        }
    });
    if (spineTables === 0) {
        throw new Error(
            'criterion: no spine table found on the Wikipedia page',
        );
    }
    return items;
}

/**
 * Append every criterion spine from the previously published movie payload
 * that the new list lacks. Spine numbers are permanent, so a spine missing
 * from Wikipedia is a page error (e.g. a duplicated spine typo), not a
 * removal. The appended items carry no title: matchItem resolves them from
 * the prevResolved cache built from that same payload.
 *
 * @param {ScrapedItem[]} items
 * @param {object | null} published  previous data/movie.json
 * @returns {ScrapedItem[]}
 */
export function addPublishedSpines(items, published) {
    const have = new Set(items.map(it => it.externalId));
    const missing = new Set();
    for (const entries of Object.values(
        published?.categories?.movie?.items ?? {},
    )) {
        for (const e of entries) {
            if (
                e?.source === 'criterion' &&
                e.externalId &&
                !have.has(e.externalId)
            ) {
                missing.add(String(e.externalId));
            }
        }
    }
    const added = [...missing]
        .sort((a, b) => Number(a) - Number(b))
        .map(spine => ({
            externalId: spine,
            rank: null,
            spineNumber: spine,
            title: '',
            year: '',
        }));
    return [...items, ...added];
}

/**
 * Expand a wikitable into a grid of cleaned cell texts, resolving rowspan and
 * colspan so every row has its full set of columns. The first all-<th> row
 * becomes the (lower-cased) header; rows with no cells are dropped.
 *
 * @returns {string[][]} [header, ...rows], or [] when there is no header
 */
function expandTable($, table) {
    const pending = []; // column index → { text, rowsLeft } from rowspans
    let header = null;
    const rows = [];
    $(table)
        .find('tr')
        .each((_, tr) => {
            const cells = $(tr).children('th,td').toArray();
            if (cells.length === 0) return;
            const row = [];
            let c = 0;
            const fillSpanned = () => {
                while (pending[c]?.rowsLeft > 0) {
                    row[c] = pending[c].text;
                    pending[c].rowsLeft--;
                    c++;
                }
            };
            for (const cell of cells) {
                fillSpanned();
                const text = cellText($, cell);
                const rowspan = Number($(cell).attr('rowspan')) || 1;
                const colspan = Number($(cell).attr('colspan')) || 1;
                for (let k = 0; k < colspan; k++, c++) {
                    row[c] = text;
                    if (rowspan > 1)
                        pending[c] = { text, rowsLeft: rowspan - 1 };
                }
            }
            fillSpanned();
            if (!header && cells.every(el => el.tagName === 'th')) {
                header = row.map(h => h.toLowerCase());
            } else if (header) {
                rows.push(row);
            }
        });
    return header ? [header, ...rows] : [];
}

/** Cell text without footnote markers, daggers or hidden sort keys. */
function cellText($, cell) {
    const $cell = $(cell).clone();
    $cell.find('sup, [style*="display:none"]').remove();
    return $cell.text().replace(/[†‡]/g, '').replace(/\s+/g, ' ').trim();
}

export {
    LIST_URL as CRITERION_LIST_URL,
    WIKIPEDIA_LIST_URL as CRITERION_WIKIPEDIA_LIST_URL,
};
