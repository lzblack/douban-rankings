// MDBList ratings enrichment — pure transforms + isolated network layer.
//
// Used by the standalone `pnpm run enrich` step: pick which titles to enrich,
// which are stale, fetch cross-platform scores from MDBList by IMDb id, and
// merge them back into a category payload as an additive `ratings` map
// (schemaVersion stays 1; consumers ignore it until they opt in).
//
// MDBList's by-imdb endpoint requires the media type in the path
// (`/imdb/movie/{tt}` vs `/imdb/show/{tt}`) — a wrong type 404s. We derive the
// type from each source's subCategory (tv → show) and fall back to the other
// type once on a 404, so a miscategorized id still resolves.

const TT_RE = /^(tt\d+)/;

// MDBList `ratings[].source` slug → our compact key. Only sources with a
// reliable 0–100 `score` are kept; rogerebert (4-pt, score null) and
// myanimelist (null for non-anime) are intentionally dropped.
const SLUG_TO_KEY = {
    imdb: 'imdb',
    metacritic: 'metacritic',
    tomatoes: 'rt',
    popcorn: 'rtAudience',
    tomatoesaudience: 'rtAudience', // legacy mdblist.com/api slug — accepted defensively
    letterboxd: 'letterboxd',
    tmdb: 'tmdb',
};

/**
 * Collect the IMDb tt ids worth enriching from a category payload, mapped to
 * the Douban subject ids that carry them plus the MDBList media type to query.
 * Only entries whose `externalId` looks like a tt id qualify — non-imdb sources
 * (criterion spine numbers, afi title-year, pre-resolved bangumi/tv ids) are
 * skipped.
 *
 * A single tt can map to multiple doubanIds (multi-version expansion), so the
 * return groups by tt. `kind` is 'show' when any contributing source has
 * subCategory 'tv', else 'movie'.
 *
 * @param {object} movieJson full `<category>.json` payload
 * @param {string} [category]
 * @returns {Map<string, {doubanIds: string[], kind: 'movie'|'show'}>}
 */
export function collectImdbTargets(movieJson, category = 'movie') {
    const cat = movieJson?.categories?.[category];
    const items = cat?.items ?? {};
    const sources = cat?.sources ?? {};
    const acc = new Map(); // tt -> { ids:Set, isShow:boolean }
    for (const [doubanId, entries] of Object.entries(items)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            const m = TT_RE.exec(entry?.externalId ?? '');
            if (!m) continue;
            const tt = m[1];
            if (!acc.has(tt)) acc.set(tt, { ids: new Set(), isShow: false });
            const slot = acc.get(tt);
            slot.ids.add(String(doubanId));
            if (sources[entry?.source]?.subCategory === 'tv') slot.isShow = true;
        }
    }
    const out = new Map();
    for (const [tt, { ids, isShow }] of acc) {
        out.set(tt, { doubanIds: [...ids].sort(), kind: isShow ? 'show' : 'movie' });
    }
    return out;
}

/** True if this doubanId's cached rating is a negative sentinel (`{at}` only). */
function isNegativeEntry(prev) {
    return Object.keys(prev).every(k => k === 'at');
}

/** Per-doubanId staleness, honoring a shorter TTL for negative sentinels. */
function entryStale(prev, nowMs, ttlMs, negativeTtlMs) {
    if (!prev || !prev.at) return true;
    const ageMs = nowMs - Date.parse(prev.at);
    if (!(ageMs >= 0)) return true; // NaN or clock-skew → stale
    return ageMs >= (isNegativeEntry(prev) ? negativeTtlMs : ttlMs);
}

/**
 * Decide which tts need a (re)fetch: those whose ratings are missing or older
 * than their TTL. Freshness is stored per doubanId (each carries an `at`
 * timestamp); a tt is stale if ANY of its doubanIds lacks a fresh rating, so a
 * newly-expanded version gets backfilled. An unparseable `at` counts as stale.
 * A negative sentinel (`{at}` with no scores — a MDBList miss) uses
 * `negativeTtlMs` so absent titles are rechecked sooner than they'd otherwise
 * be, without churning every run.
 *
 * @param {Map<string, {doubanIds: string[]}>} targets from collectImdbTargets
 * @param {Record<string, {at?: string}>} [prevRatings] existing ratings map (by doubanId)
 * @param {{ ttlMs: number, negativeTtlMs?: number, now?: Date }} opts
 * @returns {string[]} sorted stale tts
 */
export function selectStale(
    targets,
    prevRatings = {},
    { ttlMs, negativeTtlMs = ttlMs, now = new Date() } = {},
) {
    if (!(ttlMs > 0)) throw new Error('selectStale: ttlMs must be a positive number');
    const nowMs = now.getTime();
    const stale = [];
    for (const [tt, { doubanIds }] of targets) {
        const anyStale = doubanIds.some(id =>
            entryStale(prevRatings[id], nowMs, ttlMs, negativeTtlMs),
        );
        if (anyStale) stale.push(tt);
    }
    stale.sort();
    return stale;
}

/**
 * Map an MDBList media response to our compact `{imdb, rt, rtAudience,
 * metacritic, letterboxd, tmdb}` score map. Sources not in SLUG_TO_KEY, and any
 * whose `score` is not a finite number, are dropped — so a TV title with no
 * Letterboxd score simply omits that key.
 *
 * @param {object} json MDBList response (has `ratings[]`)
 * @returns {Record<string, number>}
 */
export function normalizeMdblistResponse(json) {
    const out = {};
    const ratings = Array.isArray(json?.ratings) ? json.ratings : [];
    for (const r of ratings) {
        const key = SLUG_TO_KEY[r?.source];
        if (!key) continue;
        const score = r?.score;
        if (typeof score !== 'number' || !Number.isFinite(score)) continue;
        out[key] = Math.round(score);
    }
    return out;
}

/**
 * Fetch and normalize ratings for one tt. Tries the hinted media type first,
 * falling back to the other on a 404 (wrong type / not found under that type).
 * Returns null on network error, non-ok/non-404 status, or when the title is
 * absent under both types. The ONLY network function in this module.
 *
 * @param {string} tt e.g. 'tt0111161'
 * @param {'movie'|'show'} kind hint from collectImdbTargets
 * @param {{ http: {fetch: Function}, key: string }} deps
 * @returns {Promise<Record<string, number>|null>}
 */
export async function fetchRatings(tt, kind, { http, key }) {
    const order = kind === 'show' ? ['show', 'movie'] : ['movie', 'show'];
    for (const k of order) {
        const url =
            `https://api.mdblist.com/imdb/${k}/${tt}` +
            `?apikey=${encodeURIComponent(key)}&append_to_response=ratings`;
        let res;
        try {
            res = await http.fetch(url);
        } catch {
            return null;
        }
        if (res.status === 404) continue; // wrong media type / not found under it
        if (!res.ok) return null;
        let json;
        try {
            json = await res.json();
        } catch {
            return null;
        }
        if (json?.error) continue; // 200-with-error guard
        return normalizeMdblistResponse(json);
    }
    return null;
}

/**
 * Merge freshly-fetched ratings into a category payload as an additive
 * `categories.<category>.ratings` map keyed by doubanId. Returns a NEW payload
 * (existing `sources`/`items` untouched; prior ratings not in this batch are
 * preserved). Each injected entry is stamped with `at = now`. An empty score
 * object is written as an `{at}`-only **negative sentinel** (MDBList had no
 * data) so it is not re-fetched every run — contract-safe since consumers
 * already treat every platform field as optional.
 *
 * @param {object} movieJson
 * @param {Record<string, Record<string, number>>} ratingsByDoubanId doubanId → {imdb, rt, ...} (may be {})
 * @param {{ now?: Date, category?: string }} [opts]
 * @returns {object} new payload
 */
export function injectRatings(movieJson, ratingsByDoubanId, { now = new Date(), category = 'movie' } = {}) {
    const cat = movieJson?.categories?.[category];
    if (!cat) return movieJson;
    const at = now.toISOString();
    const merged = { ...(cat.ratings ?? {}) };
    for (const [doubanId, scores] of Object.entries(ratingsByDoubanId ?? {})) {
        merged[doubanId] = { ...(scores ?? {}), at };
    }
    return {
        ...movieJson,
        categories: {
            ...movieJson.categories,
            [category]: { ...cat, ratings: merged },
        },
    };
}

/**
 * Staleness sort key for a tt: the OLDEST `at` among its doubanIds, in ms.
 * Missing/invalid timestamps rank as -Infinity so untouched titles are fetched
 * first — this makes the per-run request cap rotate fairly instead of always
 * refetching the same alphabetical prefix.
 */
function stalenessRank(tt, targets, prevRatings) {
    const { doubanIds } = targets.get(tt);
    let oldest = Infinity;
    for (const id of doubanIds) {
        const at = prevRatings[id]?.at;
        const t = at ? Date.parse(at) : NaN;
        const val = Number.isFinite(t) ? t : -Infinity;
        if (val < oldest) oldest = val;
    }
    return oldest;
}

/** Order stale tts most-stale-first (missing → oldest), tie-broken by tt. */
export function orderByStaleness(tts, targets, prevRatings) {
    return [...tts].sort((a, b) => {
        const ra = stalenessRank(a, targets, prevRatings);
        const rb = stalenessRank(b, targets, prevRatings);
        if (ra !== rb) return ra - rb;
        return a < b ? -1 : a > b ? 1 : 0;
    });
}

/**
 * Orchestrate one enrich pass over a category payload: collect tt targets,
 * pick the stale ones, order most-stale-first, and fetch within a HTTP-request
 * budget (`maxRequests`) — not a title count, because a MDBList miss costs two
 * requests (movie then show fallback). Misses are negative-cached so they don't
 * churn. Pure of file/env I/O (the CLI wrapper supplies `http`/`key` and
 * persists the result), so it is fully unit-testable.
 *
 * @param {object} movieJson
 * @param {{ http: object, key: string, ttlMs: number, negativeTtlMs?: number,
 *           maxRequests?: number, now?: Date, category?: string,
 *           log?: (m: string) => void }} opts
 * @returns {Promise<{ payload: object, summary: object }>}
 */
export async function enrichPayload(
    movieJson,
    {
        http,
        key,
        ttlMs,
        negativeTtlMs = ttlMs,
        maxRequests = 900,
        now = new Date(),
        category = 'movie',
        log = () => {},
    },
) {
    const targets = collectImdbTargets(movieJson, category);
    const prevRatings = movieJson?.categories?.[category]?.ratings ?? {};
    const stale = selectStale(targets, prevRatings, { ttlMs, negativeTtlMs, now });
    const ordered = orderByStaleness(stale, targets, prevRatings);

    // Count actual HTTP requests so the daily quota is truly respected. Each
    // title costs 1 (hit on first media type) or 2 (fallback / miss); reserve
    // the worst case before starting a title so we never exceed the budget.
    let requests = 0;
    const countingHttp = {
        fetch: (...args) => {
            requests++;
            return http.fetch(...args);
        },
    };

    const ratingsByDoubanId = {};
    let withRatings = 0;
    let noData = 0;
    let attempted = 0;
    for (const tt of ordered) {
        if (requests + 2 > maxRequests) break;
        attempted++;
        const { doubanIds, kind } = targets.get(tt);
        const scores = await fetchRatings(tt, kind, { http: countingHttp, key });
        const present = scores && Object.keys(scores).length > 0;
        if (present) withRatings++;
        else noData++;
        // present → scores; miss → {} (injectRatings writes an {at} sentinel)
        for (const id of doubanIds) ratingsByDoubanId[id] = present ? scores : {};
    }
    const skippedByCap = ordered.length - attempted;

    log(
        `${targets.size} tt targets · ${stale.length} stale · attempted ${attempted} ` +
            `(${requests} requests) · ${skippedByCap} left for next run`,
    );

    const payload = injectRatings(movieJson, ratingsByDoubanId, { now, category });
    const summary = {
        ttTargets: targets.size,
        fresh: targets.size - stale.length,
        stale: stale.length,
        attempted,
        requests,
        withRatings,
        noData,
        skippedByCap,
    };
    return { payload, summary };
}
