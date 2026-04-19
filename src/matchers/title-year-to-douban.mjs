import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadTitleIndex, normalizeTitle } from '../util/imdb-datasets.mjs';
import { loadPtgenReverseMap } from '../util/ptgen.mjs';

const DEFAULT_MAPPING_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'manual-mapping.yaml',
);

let _cached;

function loadDefaultMapping() {
    if (_cached !== undefined) return _cached;
    try {
        _cached = parseYaml(readFileSync(DEFAULT_MAPPING_PATH, 'utf-8')) ?? {};
    } catch (err) {
        if (err.code === 'ENOENT') _cached = {};
        else throw err;
    }
    return _cached;
}

/**
 * Resolve a (title, year) pair to every known Douban subject id.
 *
 * Returns an **array** (possibly multiple dbids) for the same
 * multi-version reason as imdb-to-douban — one CC spine can correspond
 * to distinct Douban subjects for the original release and the
 * restoration we actually matched via IMDB title index.
 *
 * Three-layer strategy:
 *   1. manual-mapping.yaml `titles` section, key = "normalized-title|year"
 *      returns a single-dbid array
 *   2. IMDB datasets title index → tt → PtGen reverse map → all dbids
 *   3. search.douban.com with the title, year-filtered; single dbid.
 *      Skipped when `options.skipSearchFallback` is true (Criterion opts out).
 *
 * Returns [] when nothing resolved — caller logs unresolved for manual
 * curation into config/manual-mapping.yaml.
 *
 * @param {{ title: string, year: string | number }} query
 * @param {{ fetch: Function }} http
 * @param {{
 *   manualMapping?: { titles?: Record<string, string | number> },
 *   ptgenMap?: Map<string, string[]> | null,
 *   skipSearchFallback?: boolean,
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function matchTitleYearToDouban(query, http, options = {}) {
    const { title, year } = query;
    if (!title) return [];

    // Layer 1: manual mapping
    const mapping = options.manualMapping ?? loadDefaultMapping();
    const manualKey = manualMappingKey(title, year);
    const manual = mapping?.titles?.[manualKey];
    if (manual != null) return [String(manual)];

    // Layer 2: IMDB title index → tt → PtGen reverse (all dbids)
    if (year) {
        const titleIndex = await loadTitleIndex(http);
        const normKey = `${normalizeTitle(title)}|${year}`;
        const tt = titleIndex.get(normKey);
        if (tt) {
            const ptgen =
                options.ptgenMap !== undefined
                    ? options.ptgenMap
                    : await loadPtgenReverseMap(http);
            const dbids = ptgen?.get(tt);
            if (dbids?.length) return dbids.slice();
        }
    }

    // Layer 3: Douban search (best-effort, year-verified)
    if (options.skipSearchFallback) return [];
    const dbid = await searchDoubanByTitle(title, year, http);
    return dbid ? [dbid] : [];
}

/**
 * The key format we use in manual-mapping.yaml `titles:`. Exported so
 * maintainers can compute the exact key for a new override without
 * having to replicate the normalization.
 */
export function manualMappingKey(title, year) {
    return `${normalizeTitle(title)}|${year ?? ''}`;
}

async function searchDoubanByTitle(title, year, http) {
    const url = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(title)}`;
    const res = await http.fetch(url);
    if (!res.ok) return null;
    const html = await res.text();

    const m = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
    if (!m) return null;
    let data;
    try {
        data = JSON.parse(m[1]);
    } catch {
        return null;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) return null;

    const yearNum = year != null ? Number(year) : NaN;
    if (!Number.isNaN(yearNum)) {
        const exact = items.find(it => resultYear(it) === yearNum);
        if (exact?.id) return String(exact.id);
        const near = items.find(it => {
            const y = resultYear(it);
            return y != null && Math.abs(y - yearNum) <= 1;
        });
        if (near?.id) return String(near.id);
    }
    return null;
}

function resultYear(item) {
    const title = item?.title ?? '';
    const m = title.match(/\((\d{4})\)/);
    return m ? Number(m[1]) : null;
}
