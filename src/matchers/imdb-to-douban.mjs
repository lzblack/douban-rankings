import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
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
 * Resolve an IMDB title id to a Douban subject id.
 *
 * Three-layer strategy (inspired by rank4douban's approach):
 *   1. `manual-mapping.yaml` / `options.manualMapping` — human-curated
 *      overrides, always wins.
 *   2. PtGen archive (~400K IMDB↔Douban pairs) — one fetch at startup,
 *      O(1) map lookup thereafter. Covers the vast majority of
 *      mainstream films.
 *   3. `search.douban.com/movie/subject_search?search_text={ttID}` —
 *      fallback for titles not in PtGen (new releases, niche picks).
 *      Returns HTML; we pick the first `/subject/\d+/` in the body.
 *
 * Historical notes: an older path `movie.douban.com/imdb/{ttID}/` used
 * to 302 to `/subject/<id>/` and was our first implementation. That
 * endpoint now 404s universally. The PtGen + search combo replaces it
 * and is dramatically faster (250 hits via PtGen are microseconds vs.
 * 250 × 5 s of rate-limited search requests).
 *
 * @param {string} imdbId  e.g. 'tt0110912'
 * @param {{ fetch: (url: string, init?: RequestInit) => Promise<Response> }} http
 * @param {{
 *   manualMapping?: { imdb?: Record<string, string | number> },
 *   ptgenMap?: Map<string, string> | null,
 * }} [options]
 * @returns {Promise<string | null>}  Douban subject id, or null when unmatched
 */
export async function matchImdbToDouban(imdbId, http, options = {}) {
    // Layer 1: manual mapping
    const mapping = options.manualMapping ?? loadDefaultMapping();
    const manual = mapping?.imdb?.[imdbId];
    if (manual != null) return String(manual);

    // Layer 2: PtGen archive
    const ptgen =
        options.ptgenMap !== undefined
            ? options.ptgenMap
            : await loadPtgenMap(http);
    if (ptgen?.has(imdbId)) return ptgen.get(imdbId);

    // Layer 3: Douban search fallback
    const url = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(imdbId)}`;
    const res = await http.fetch(url);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/\/subject\/(\d+)/);
    return m ? m[1] : null;
}
