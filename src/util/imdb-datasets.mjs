import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

/**
 * Shared IMDb non-commercial datasets loader.
 *
 * Multiple callers (imdb-top250 source, title-year matcher, etc.) need
 * to query the same underlying TSV files. A per-process cache means
 * each dataset is downloaded and parsed at most once per pipeline run.
 *
 * Datasets:
 *   - title.ratings.tsv.gz  (~7 MB gz)  tt → averageRating, numVotes
 *   - title.basics.tsv.gz   (~200 MB gz) tt → type, titles, year, genres
 *
 * License: personal/non-commercial use per IMDb's terms.
 * Docs: https://developer.imdb.com/non-commercial-datasets/
 */

export const RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
export const BASICS_URL = 'https://datasets.imdbws.com/title.basics.tsv.gz';

/** Default vote threshold for "Top 250"-class ranking lists. */
export const MIN_VOTES_DEFAULT = 25000;
/** Default Bayesian prior rating. */
export const MEAN_VOTE_DEFAULT = 7.0;

/** @type {Map<string, { rating: number, votes: number }> | undefined} */
let _ratingsCache;

/** @type {Map<string, Array<{ tconst: string, primaryTitle: string, originalTitle: string, year: string }>> | undefined} */
let _basicsByType;

/** @type {Map<string, string> | undefined} */
let _titleIndexCache;

// Titles we actually care about cached during the basics stream. Keeps
// memory bounded compared to the full 11M-row basics dump. Callers
// (sources) can still apply tighter rating / vote filters in-memory.
const KEPT_TYPES = new Set(['movie', 'tvSeries', 'tvMiniSeries']);

/**
 * Load all ratings (no vote threshold). Source-level filtering (e.g.
 * movies want ≥25 000 votes, TV shows ≥5 000) happens in memory
 * after this returns; hard-coding a threshold here would prevent
 * multi-source scenarios from sharing the cache.
 *
 * @param {{ fetch: Function }} http
 * @returns {Promise<Map<string, { rating: number, votes: number }>>}
 */
export async function loadRatings(http) {
    if (_ratingsCache) return _ratingsCache;
    const map = new Map();
    await streamTsvRows(http, RATINGS_URL, cols => {
        const votes = Number(cols[2]);
        if (votes > 0) {
            map.set(cols[0], { rating: Number(cols[1]), votes });
        }
    });
    _ratingsCache = map;
    return map;
}

/**
 * Stream title.basics once; bucket into per-type arrays (movie /
 * tvSeries / tvMiniSeries). Other types (short / video / tvEpisode)
 * are dropped early to keep memory bounded — we don't rank them.
 *
 * @param {{ fetch: Function }} http
 * @returns {Promise<Map<string, Array<{ tconst: string, primaryTitle: string, originalTitle: string, year: string }>>>}
 */
export async function loadBasicsByType(http) {
    if (_basicsByType) return _basicsByType;
    const map = new Map();
    for (const t of KEPT_TYPES) map.set(t, []);
    await streamTsvRows(http, BASICS_URL, cols => {
        const type = cols[1];
        if (!KEPT_TYPES.has(type)) return;
        const year = cols[5];
        map.get(type).push({
            tconst: cols[0],
            primaryTitle: cols[2],
            originalTitle: cols[3],
            year: year === '\\N' ? '' : year,
        });
    });
    _basicsByType = map;
    return map;
}

/** Back-compat thin wrapper. Prefer `loadBasicsByType` for new sources. */
export async function loadMovieBasics(http) {
    const byType = await loadBasicsByType(http);
    return byType.get('movie') ?? [];
}

/**
 * TV series + mini-series together. Callers that only want one kind
 * can further filter; the pair is almost always treated together for
 * ranking purposes (IMDb's own Top 250 TV list mixes them).
 *
 * @param {{ fetch: Function }} http
 * @returns {Promise<Array<{ tconst: string, primaryTitle: string, originalTitle: string, year: string }>>}
 */
export async function loadTvBasics(http) {
    const byType = await loadBasicsByType(http);
    return [
        ...(byType.get('tvSeries') ?? []),
        ...(byType.get('tvMiniSeries') ?? []),
    ];
}

/**
 * Build a `(normalizedTitle|year) → tt` index over movie basics. Indexes
 * both primaryTitle and originalTitle (they often differ for non-English
 * films). On collisions the first tt wins — good enough for our use
 * case since title-year matchers are already tolerant of misses.
 *
 * @param {{ fetch: Function }} http
 * @returns {Promise<Map<string, string>>}
 */
export async function loadTitleIndex(http) {
    if (_titleIndexCache) return _titleIndexCache;
    const basics = await loadMovieBasics(http);
    const index = new Map();
    for (const b of basics) {
        if (!b.year) continue;
        indexPut(index, b.primaryTitle, b.year, b.tconst);
        if (b.originalTitle && b.originalTitle !== b.primaryTitle) {
            indexPut(index, b.originalTitle, b.year, b.tconst);
        }
    }
    _titleIndexCache = index;
    return index;
}

function indexPut(index, title, year, tt) {
    const key = `${normalizeTitle(title)}|${year}`;
    if (!index.has(key)) index.set(key, tt);
}

/**
 * Lowercase, strip common punctuation, collapse whitespace.
 * Keeps accented characters (é, ö, ñ, etc.) intact since the basics
 * table preserves them and we want matching to survive them.
 */
export function normalizeTitle(t) {
    return String(t)
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[.,:;!?'"()\[\]{}\u2018\u2019\u201c\u201d]/g, '')
        .replace(/[-_/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * IMDb's publicly documented Bayesian weighted rating. Used by sources
 * that rank titles (imdb-top250). Exported for direct reuse.
 *
 * @param {Array<{ tconst: string, title?: string, rating: number, votes: number }>} qualifying
 * @param {{ minVotes?: number, meanVote?: number, topN?: number }} [opts]
 */
export function computeWeightedRanking(
    qualifying,
    {
        minVotes = MIN_VOTES_DEFAULT,
        meanVote = MEAN_VOTE_DEFAULT,
        topN = Infinity,
    } = {},
) {
    for (const m of qualifying) {
        m.wr =
            (m.votes / (m.votes + minVotes)) * m.rating +
            (minVotes / (m.votes + minVotes)) * meanVote;
    }
    qualifying.sort((a, b) => b.wr - a.wr);
    return qualifying.slice(0, topN);
}

/** Exported for tests that want a clean state. */
export function _resetDatasetsCache() {
    _ratingsCache = undefined;
    _basicsByType = undefined;
    _titleIndexCache = undefined;
}

/**
 * Stream a gzipped TSV, invoke `onRow(cols)` for each data row
 * (header skipped). Memory is bounded: lines processed one at a time.
 *
 * @param {{ fetch: Function }} http
 * @param {string} url
 * @param {(cols: string[]) => void} onRow
 */
async function streamTsvRows(http, url, onRow) {
    const res = await http.fetch(url);
    if (!res.ok) {
        throw new Error(`imdb-datasets: HTTP ${res.status} from ${url}`);
    }
    const nodeStream = Readable.fromWeb(res.body);
    const gunzipped = nodeStream.pipe(createGunzip());
    const rl = createInterface({ input: gunzipped, crlfDelay: Infinity });
    let firstLine = true;
    for await (const line of rl) {
        if (firstLine) {
            firstLine = false;
            continue;
        }
        if (!line) continue;
        onRow(line.split('\t'));
    }
}
