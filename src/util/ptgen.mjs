/**
 * PtGen archive loader.
 *
 * Fetches the static IMDB↔Douban mapping export (~400K pairs) from
 * OurBits's PtGen archive once per process and caches the result.
 * Multiple matchers (imdb-to-douban, title-year-to-douban) share this
 * cache — the 35 MB download only happens once per pipeline run.
 *
 * License note: PtGen is distributed with a "learning purposes only"
 * notice. We consume it read-only (no redistribute), in line with how
 * the archive has been consumed by rank4douban et al for years.
 *
 * Credits:
 *   - Archive: https://ourbits.github.io/PtGen/
 *   - Upstream pt-gen-cfworker by R酱 Rhilip (now archived; community
 *     forks continue at YunFeng86/pt-gen-universal, rabbitwit/PT-Gen-Refactor)
 *   - OurBits runs an active instance and publishes the static export.
 */

const PTGEN_MAP_URL =
    'https://ourbits.github.io/PtGen/internal_map/douban_imdb_map.json';

/** @type {Map<string,string> | null | undefined} null = load failed; undefined = not loaded yet */
let _cache;

/**
 * Load the PtGen IMDB→Douban mapping. Returns null on fetch failure so
 * callers can gracefully degrade (e.g. fall through to Douban search).
 *
 * @param {{ fetch: Function }} http
 * @returns {Promise<Map<string, string> | null>}
 */
export async function loadPtgenMap(http) {
    if (_cache !== undefined) return _cache;
    try {
        const res = await http.fetch(PTGEN_MAP_URL);
        if (!res.ok) {
            console.warn(`[ptgen] fetch failed: HTTP ${res.status}`);
            _cache = null;
            return null;
        }
        const data = await res.json();
        const map = new Map();
        for (const row of data) {
            if (row?.imdbid && row?.dbid != null) {
                map.set(row.imdbid, String(row.dbid));
            }
        }
        console.log(`[ptgen] map loaded: ${map.size} entries`);
        _cache = map;
        return map;
    } catch (err) {
        console.warn(`[ptgen] load error: ${err.message}`);
        _cache = null;
        return null;
    }
}

/** Exported for tests that want a clean state. */
export function _resetPtgenCache() {
    _cache = undefined;
}
