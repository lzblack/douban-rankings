// MDBList ratings enrichment — pure transforms.
//
// This module holds the endpoint-independent logic used by the standalone
// `pnpm run enrich` step: which titles to enrich, which are stale, and how to
// merge fetched ratings back into a category payload as an additive `ratings`
// map (schemaVersion stays 1; consumers ignore it until they opt in).
//
// The network layer (fetchRatings) and the MDBList response normalizer live in
// this file too but are added once the real API shape is pinned — see plan
// Step 0. Everything below is deterministic and unit-tested with no network.

const TT_RE = /^(tt\d+)/;

/**
 * Collect the IMDb tt ids worth enriching from a category payload, mapped to
 * the Douban subject ids that carry them. Only entries whose `externalId`
 * looks like a tt id qualify — non-imdb sources (criterion spine numbers,
 * afi title-year, pre-resolved bangumi/tv ids) are skipped.
 *
 * A single tt can map to multiple doubanIds (multi-version expansion: same
 * film, different Douban subject pages). Callers fetch once per tt and fan the
 * result out to every doubanId, so the return groups by tt.
 *
 * @param {object} movieJson full `<category>.json` payload
 * @param {string} [category]
 * @returns {Map<string, string[]>} tt → sorted unique doubanId[]
 */
export function collectImdbTargets(movieJson, category = 'movie') {
    const items = movieJson?.categories?.[category]?.items ?? {};
    const byTt = new Map(); // tt -> Set<doubanId>
    for (const [doubanId, entries] of Object.entries(items)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
            const m = TT_RE.exec(entry?.externalId ?? '');
            if (!m) continue;
            const tt = m[1];
            if (!byTt.has(tt)) byTt.set(tt, new Set());
            byTt.get(tt).add(String(doubanId));
        }
    }
    const out = new Map();
    for (const [tt, ids] of byTt) out.set(tt, [...ids].sort());
    return out;
}

/**
 * Decide which tts need a (re)fetch: those whose ratings are missing or older
 * than `ttlMs`. Freshness is stored per doubanId (each carries an `at`
 * timestamp); a tt is stale if ANY of its doubanIds lacks a fresh rating, so a
 * newly-expanded version gets backfilled. An unparseable `at` counts as stale.
 *
 * @param {Map<string, string[]>} targets from collectImdbTargets
 * @param {Record<string, {at?: string}>} [prevRatings] existing ratings map (by doubanId)
 * @param {{ ttlMs: number, now?: Date }} opts
 * @returns {string[]} sorted stale tts
 */
export function selectStale(targets, prevRatings = {}, { ttlMs, now = new Date() } = {}) {
    if (!(ttlMs > 0)) throw new Error('selectStale: ttlMs must be a positive number');
    const nowMs = now.getTime();
    const stale = [];
    for (const [tt, doubanIds] of targets) {
        const anyStale = doubanIds.some(id => {
            const prev = prevRatings[id];
            if (!prev || !prev.at) return true;
            const ageMs = nowMs - Date.parse(prev.at);
            return !(ageMs >= 0 && ageMs < ttlMs); // NaN or expired → stale
        });
        if (anyStale) stale.push(tt);
    }
    stale.sort();
    return stale;
}

/**
 * Merge freshly-fetched ratings into a category payload as an additive
 * `categories.<category>.ratings` map keyed by doubanId. Returns a NEW payload
 * (existing `sources`/`items` untouched; prior ratings not in this batch are
 * preserved). Each injected entry is stamped with `at = now`. Empty score
 * objects are skipped.
 *
 * @param {object} movieJson
 * @param {Record<string, Record<string, number>>} ratingsByDoubanId doubanId → {imdb, rt, ...}
 * @param {{ now?: Date, category?: string }} [opts]
 * @returns {object} new payload
 */
export function injectRatings(movieJson, ratingsByDoubanId, { now = new Date(), category = 'movie' } = {}) {
    const cat = movieJson?.categories?.[category];
    if (!cat) return movieJson;
    const at = now.toISOString();
    const merged = { ...(cat.ratings ?? {}) };
    for (const [doubanId, scores] of Object.entries(ratingsByDoubanId ?? {})) {
        if (!scores || Object.keys(scores).length === 0) continue;
        merged[doubanId] = { ...scores, at };
    }
    return {
        ...movieJson,
        categories: {
            ...movieJson.categories,
            [category]: { ...cat, ratings: merged },
        },
    };
}
