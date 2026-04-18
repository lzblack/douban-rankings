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
 * @param {string} categoryId
 * @param {SourceRunResult[]} sourceResults
 * @param {BuildOptions} [options]
 */
export function buildCategoryPayload(
    categoryId,
    sourceResults,
    { now = new Date() } = {},
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
    return {
        schemaVersion: 1,
        generatedAt: now.toISOString(),
        categories: {
            [categoryId]: {
                sources,
                items: aggregateItems(sourceResults),
            },
        },
    };
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
 * Write JSON atomically: write to `<path>.tmp`, then rename over `<path>`.
 * Rename is atomic on POSIX and on NTFS for same-volume renames, so readers
 * never see a half-written file.
 *
 * @param {string} path
 * @param {unknown} data
 */
export async function writeJsonAtomic(path, data) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    await rename(tmp, path);
}
