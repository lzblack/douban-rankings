import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { loadTitleIndex, normalizeTitle } from '../util/imdb-datasets.mjs';
import { loadPtgenMap } from '../util/ptgen.mjs';

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
 * Resolve a (title, year) pair to a Douban subject id.
 *
 * Three-layer strategy, mirrors imdb-to-douban but indirect through
 * IMDB datasets:
 *   1. manual-mapping.yaml `titles` section, key = "normalized-title|year"
 *   2. IMDB datasets title index → tt → PtGen map → douban subject id
 *   3. search.douban.com with the title; parse window.__DATA__ JSON;
 *      pick the item whose title's year in parens matches (±1 tolerance)
 *
 * Returns null when no layer resolves — caller (pipeline) logs it as
 * unresolved for manual curation into config/manual-mapping.yaml.
 *
 * @param {{ title: string, year: string | number }} query
 * @param {{ fetch: Function }} http
 * @param {{
 *   manualMapping?: { titles?: Record<string, string | number> },
 *   ptgenMap?: Map<string, string> | null,
 * }} [options]
 * @returns {Promise<string | null>}
 */
export async function matchTitleYearToDouban(query, http, options = {}) {
    const { title, year } = query;
    if (!title) return null;

    // Layer 1: manual mapping, keyed by "normalized-title|year"
    const mapping = options.manualMapping ?? loadDefaultMapping();
    const manualKey = manualMappingKey(title, year);
    const manual = mapping?.titles?.[manualKey];
    if (manual != null) return String(manual);

    // Layer 2: IMDB title index → tt → PtGen
    if (year) {
        const titleIndex = await loadTitleIndex(http);
        const normKey = `${normalizeTitle(title)}|${year}`;
        const tt = titleIndex.get(normKey);
        if (tt) {
            const ptgen =
                options.ptgenMap !== undefined
                    ? options.ptgenMap
                    : await loadPtgenMap(http);
            const dbid = ptgen?.get(tt);
            if (dbid) return String(dbid);
        }
    }

    // Layer 3: Douban search by title, match year from result title
    return await searchDoubanByTitle(title, year, http);
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

    // Douban embeds structured results in window.__DATA__. Parsing that is
    // much more reliable than scraping DOM or matching /subject/\d+/ which
    // could pick up any link on the page.
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
        // Prefer exact year match
        const exact = items.find(it => resultYear(it) === yearNum);
        if (exact?.id) return String(exact.id);
        // Accept ±1 year tolerance (release-year ambiguity)
        const near = items.find(it => {
            const y = resultYear(it);
            return y != null && Math.abs(y - yearNum) <= 1;
        });
        if (near?.id) return String(near.id);
    }

    // No year filter possible / matched — do NOT fall back to first item:
    // that's how we used to get wrong matches. Return null and let the
    // result go into the unresolved log for manual curation.
    return null;
}

function resultYear(item) {
    const title = item?.title ?? '';
    const m = title.match(/\((\d{4})\)/);
    return m ? Number(m[1]) : null;
}
