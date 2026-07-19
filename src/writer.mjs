import { writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_BASE_URL = 'https://rank.douban.zhili.dev';

/**
 * @typedef {Object} MatchedItem
 * @property {string} doubanId
 * @property {number|null} rank
 * @property {string} externalId
 * @property {string} [spineNumber]
 *
 * @typedef {Object} SourceRunResult
 * @property {Object} sourceDef   the source module (id, category, kind, meta, ...)
 * @property {MatchedItem[]} items
 * @property {number} itemCount
 * @property {Date} updatedAt
 *
 * @typedef {Object} BuildOptions
 * @property {Date} [now]
 */

/**
 * Build the `<category>.json` payload defined by the project JSON contract.
 *
 * `prevRatings` (the previous run's `categories.<cat>.ratings` map) is carried
 * forward for every doubanId still present in the new items, so a `pnpm run
 * update` rebuild does NOT wipe the MDBList enrichment (`pnpm run enrich`).
 * Ratings for dropped doubanIds are discarded; the pipeline never fetches or
 * touches an API key — it only preserves data already on disk.
 *
 * @param {string} categoryId
 * @param {SourceRunResult[]} sourceResults
 * @param {BuildOptions & { prevRatings?: object|null }} [options]
 */
export function buildCategoryPayload(
    categoryId,
    sourceResults,
    { now = new Date(), prevRatings = null } = {},
) {
    const sources = {};
    for (const r of sourceResults) {
        const d = r.sourceDef;
        sources[d.id] = {
            title: d.meta.title,
            titleZh: d.meta.titleZh,
            url: d.meta.url,
            kind: d.kind,
            subCategory: d.subCategory,
            priority: d.priority,
            updatedAt: r.updatedAt.toISOString(),
            itemCount: r.itemCount,
        };
    }
    const items = aggregateItems(sourceResults);
    const category = { sources, items };
    const carried = carryForwardRatings(items, prevRatings);
    if (carried) category.ratings = carried;
    return {
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        categories: { [categoryId]: category },
    };
}

/** Keep prior ratings only for doubanIds still present in the new items. */
function carryForwardRatings(items, prevRatings) {
    if (!prevRatings) return null;
    const carried = {};
    for (const doubanId of Object.keys(items)) {
        if (prevRatings[doubanId]) carried[doubanId] = prevRatings[doubanId];
    }
    return Object.keys(carried).length > 0 ? carried : null;
}

function aggregateItems(sourceResults) {
    const items = {};
    for (const r of sourceResults) {
        for (const item of r.items) {
            const entry = {
                source: r.sourceDef.id,
                rank: item.rank,
                // externalId is retained so the next pipeline run can
                // restore (source, externalId → doubanId) from previous
                // output and skip remote lookups for already-resolved
                // items. Consumers MAY ignore this field (additive).
                externalId: item.externalId,
            };
            if (item.spineNumber != null) entry.spineNumber = item.spineNumber;
            // Display label: each source decides how to format its own
            // rank/spine/year so the consumer doesn't need per-source
            // rendering logic. Falsy return means "omit label, consumer
            // falls back to whatever legacy formatter it has".
            const label = r.sourceDef.formatLabel?.(item);
            if (label != null && label !== '') entry.label = String(label);
            (items[item.doubanId] ??= []).push(entry);
        }
    }
    return items;
}

/**
 * Build `manifest.json`.
 *
 * @param {string[]} categoryIds
 * @param {BuildOptions & { baseUrl?: string }} [options]
 */
export function buildManifest(
    categoryIds,
    { now = new Date(), baseUrl = DEFAULT_BASE_URL } = {},
) {
    return {
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        categories: categoryIds,
        urls: Object.fromEntries(
            categoryIds.map(id => [id, `${baseUrl}/${id}.json`]),
        ),
    };
}

/**
 * Secret-leak guard: throw if the serialized output contains any of the given
 * secret strings. Per project policy (CLAUDE.md §密钥): the writer layer is the
 * last line of defense ensuring no API key ever lands in a published JSON.
 * The thrown message deliberately never echoes the secret value.
 *
 * @param {string} serialized
 * @param {string[]} secrets
 */
export function assertNoSecrets(serialized, secrets = []) {
    for (const secret of secrets) {
        if (secret && serialized.includes(secret)) {
            throw new Error(
                'writeJsonAtomic: refusing to write — output contains a secret ' +
                    'value (API-key leak guard). Check the enrich step.',
            );
        }
    }
}

/**
 * Secrets pulled from the environment that must never appear in output.
 * Reading here means every write (pipeline + enrich) is protected once the key
 * is set, without callers having to opt in.
 */
function defaultSecrets() {
    const out = [];
    if (process.env.MDBLIST_API_KEY) out.push(process.env.MDBLIST_API_KEY);
    return out;
}

/**
 * Write JSON atomically: write to `<path>.tmp`, then rename over `<path>`.
 * Rename is atomic on POSIX and on NTFS for same-volume renames, so readers
 * never see a half-written file. Runs the secret-leak guard before touching
 * disk, so a leak aborts the write instead of publishing.
 *
 * @param {string} path
 * @param {unknown} data
 * @param {{ secrets?: string[] }} [opts]
 */
export async function writeJsonAtomic(path, data, { secrets = defaultSecrets() } = {}) {
    const serialized = JSON.stringify(data, null, 2) + '\n';
    assertNoSecrets(serialized, secrets);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, serialized, 'utf-8');
    await rename(tmp, path);
}
