import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

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
 * Strategy:
 *   1. manual-mapping.yaml override (or `options.manualMapping` for tests).
 *   2. GET search.douban.com/movie/subject_search?search_text={ttID}.
 *      Douban's movie search treats a bare IMDB id as a query and the
 *      matching subject's /subject/<id>/ URL shows up in the first card.
 *      We pick the first /subject/\d+/ found in the HTML.
 *   3. null if neither resolves.
 *
 * Historical note: an older path movie.douban.com/imdb/{ttID}/ used to
 * 302 straight to /subject/<id>/ and was our first implementation. That
 * endpoint now 404s for every IMDB id, so we fell back to the search
 * endpoint which still works.
 *
 * @param {string} imdbId  e.g. 'tt0110912'
 * @param {{ fetch: (url: string, init?: RequestInit) => Promise<Response> }} http
 * @param {{ manualMapping?: { imdb?: Record<string, string | number> } }} [options]
 * @returns {Promise<string | null>}  Douban subject id, or null when unmatched
 */
export async function matchImdbToDouban(imdbId, http, options = {}) {
    const mapping = options.manualMapping ?? loadDefaultMapping();
    const manual = mapping?.imdb?.[imdbId];
    if (manual != null) return String(manual);

    const url = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(imdbId)}`;
    const res = await http.fetch(url);
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(/\/subject\/(\d+)/);
    return m ? m[1] : null;
}
