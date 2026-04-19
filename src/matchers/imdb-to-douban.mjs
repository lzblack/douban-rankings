import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
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
 * Resolve an IMDB title id to every known Douban subject id.
 *
 * Returns an **array** (possibly with multiple dbids) because the same
 * IMDB tt can correspond to several Douban subject pages — original
 * release, 4K restoration, regional cut, etc. Each surfaces under a
 * distinct `/subject/<id>/` URL on Douban. Emitting a ranking label
 * only on one version would leave users viewing the others unlabeled,
 * so the pipeline writes one items[] entry per dbid.
 *
 * Three-layer strategy:
 *   1. `manual-mapping.yaml` override — returns a single-dbid array
 *   2. PtGen reverse map — all dbids known for this tt
 *   3. `search.douban.com` — single-hit fallback if PtGen has none
 *
 * @param {string} imdbId  e.g. 'tt0110912'
 * @param {{ fetch: (url: string, init?: RequestInit) => Promise<Response> }} http
 * @param {{
 *   manualMapping?: { imdb?: Record<string, string | number> },
 *   ptgenMap?: Map<string, string[]> | null,
 * }} [options]
 * @returns {Promise<string[]>}  Douban subject ids (empty when unmatched)
 */
export async function matchImdbToDouban(imdbId, http, options = {}) {
    // Layer 1: manual mapping. Value may be a single dbid (string/number)
    // or an array of dbids — the array form is how maintainers ship
    // multi-version coverage (legacy + restoration + regional cut)
    // when PtGen only knows one of them.
    const mapping = options.manualMapping ?? loadDefaultMapping();
    const manual = mapping?.imdb?.[imdbId];
    if (manual != null) {
        return Array.isArray(manual)
            ? manual.map(String)
            : [String(manual)];
    }

    // Layer 2: PtGen reverse map — return every version
    const ptgen =
        options.ptgenMap !== undefined
            ? options.ptgenMap
            : await loadPtgenReverseMap(http);
    const dbids = ptgen?.get(imdbId);
    if (dbids?.length) return dbids.slice();

    // Layer 3: Douban search fallback (best-effort single hit)
    const url = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(imdbId)}`;
    const res = await http.fetch(url);
    if (!res.ok) return [];
    const html = await res.text();
    const m = html.match(/\/subject\/(\d+)/);
    return m ? [m[1]] : [];
}
