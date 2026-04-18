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
 *   1. manual-mapping.yaml override (or `options.manualMapping` for tests)
 *   2. GET movie.douban.com/imdb/{ttID}/ with redirect: manual;
 *      Douban returns 302 Location → /subject/<id>/
 *   3. null if neither resolves
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

    const res = await http.fetch(`https://movie.douban.com/imdb/${imdbId}/`, {
        redirect: 'manual',
    });
    if (res.status !== 301 && res.status !== 302) return null;
    const location = res.headers.get('location');
    if (!location) return null;
    const m = location.match(/\/subject\/(\d+)/);
    return m ? m[1] : null;
}
