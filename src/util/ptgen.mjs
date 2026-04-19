/**
 * PtGen archive loader.
 *
 * Fetches the static IMDB↔Douban mapping export (~400K pairs) from
 * OurBits's PtGen archive once per process and caches the result.
 * Multiple matchers (imdb-to-douban, title-year-to-douban) share this
 * cache — the 35 MB download only happens once per pipeline run.
 *
 * Same tt can map to multiple douban subject ids (original release,
 * 4K restoration, regional cut, ...). `loadPtgenReverseMap` returns the
 * full array so callers can expand one IMDB match into every Douban
 * version — important for CC films whose spine entry on Criterion is
 * a restoration with its own Douban subject id, while users usually
 * open the legacy Douban page for the original release.
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

/** @type {Map<string, string[]> | null | undefined} null = load failed; undefined = not loaded */
let _reverseCache;

async function buildReverseMap(http) {
    if (_reverseCache !== undefined) return _reverseCache;
    try {
        const res = await http.fetch(PTGEN_MAP_URL);
        if (!res.ok) {
            console.warn(`[ptgen] fetch failed: HTTP ${res.status}`);
            _reverseCache = null;
            return null;
        }
        const data = await res.json();
        const map = new Map();
        for (const row of data) {
            if (row?.imdbid && row?.dbid != null) {
                const dbid = String(row.dbid);
                const list = map.get(row.imdbid);
                if (list) {
                    if (!list.includes(dbid)) list.push(dbid);
                } else {
                    map.set(row.imdbid, [dbid]);
                }
            }
        }
        let totalPairs = 0;
        for (const v of map.values()) totalPairs += v.length;
        console.log(
            `[ptgen] map loaded: ${map.size} imdb ids, ${totalPairs} total pairs`,
        );
        _reverseCache = map;
        return map;
    } catch (err) {
        console.warn(`[ptgen] load error: ${err.message}`);
        _reverseCache = null;
        return null;
    }
}

/**
 * Return every Douban subject id associated with an IMDB tt id.
 *
 * @param {{ fetch: Function }} http
 * @returns {Promise<Map<string, string[]> | null>}
 */
export async function loadPtgenReverseMap(http) {
    return await buildReverseMap(http);
}

/**
 * Back-compat single-match view: first dbid per imdbid. Newer callers
 * should prefer `loadPtgenReverseMap` to capture every version.
 *
 * @param {{ fetch: Function }} http
 * @returns {Promise<Map<string, string> | null>}
 */
export async function loadPtgenMap(http) {
    const reverse = await buildReverseMap(http);
    if (!reverse) return null;
    const single = new Map();
    for (const [imdbid, dbids] of reverse) {
        if (dbids[0]) single.set(imdbid, dbids[0]);
    }
    return single;
}

/** Exported for tests that want a clean state. */
export function _resetPtgenCache() {
    _reverseCache = undefined;
}
