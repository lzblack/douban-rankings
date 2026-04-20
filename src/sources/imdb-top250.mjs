import {
    loadRatings,
    loadMovieBasics,
    computeWeightedRanking,
    MIN_VOTES_DEFAULT,
} from '../util/imdb-datasets.mjs';

/**
 * Source: IMDb Top 250 (feature films).
 *
 * Data is derived from IMDb's public non-commercial datasets (via the
 * shared `util/imdb-datasets.mjs` loader) rather than the chart page —
 * imdb.com/chart/top sits behind AWS WAF and plain HTTP fetch can't
 * clear the JS challenge.
 *
 * Top 250 membership and order are computed with IMDb's publicly
 * documented Bayesian weighted rating:
 *   WR = (v/(v+m)) * R + (m/(v+m)) * C
 * with m = 25000 (vote threshold), C = 7.0 (prior). Approximates IMDb's
 * real list to within a handful of positions; membership overlap is
 * typically > 95%.
 */

const TOP_N = 250;

/** @typedef {{ externalId: string, rank: number, title: string }} ScrapedItem */

export default {
    id: 'imdb-top250',
    category: 'movie',
    subCategory: 'movie',
    kind: 'permanent',
    priority: 1,
    externalIdKind: 'imdb',
    meta: {
        title: 'IMDb Top 250',
        titleZh: 'IMDb 250 佳片',
        url: 'https://www.imdb.com/chart/top',
    },
    formatLabel: it => (it.rank == null ? null : `No.${it.rank}`),

    /**
     * @param {{ fetch: (url: string, init?: RequestInit) => Promise<Response> }} http
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(http) {
        const [ratings, basics] = await Promise.all([
            loadRatings(http),
            loadMovieBasics(http),
        ]);
        const qualifying = [];
        for (const b of basics) {
            const r = ratings.get(b.tconst);
            if (!r || r.votes < MIN_VOTES_DEFAULT) continue;
            qualifying.push({
                tconst: b.tconst,
                title: b.primaryTitle,
                rating: r.rating,
                votes: r.votes,
            });
        }
        const ranked = computeWeightedRanking(qualifying, {
            minVotes: MIN_VOTES_DEFAULT,
            topN: TOP_N,
        });
        return ranked.map((m, i) => ({
            externalId: m.tconst,
            rank: i + 1,
            title: m.title,
        }));
    },
};

/**
 * Kept for backward compatibility with existing tests. Uses the shared
 * weighted-ranking utility. Prefer `computeWeightedRanking` from
 * `util/imdb-datasets.mjs` for new code.
 *
 * @param {Array<{ tconst: string, title: string, rating: number, votes: number }>} qualifying
 * @returns {ScrapedItem[]}
 */
export function computeTop250(qualifying) {
    const ranked = computeWeightedRanking(qualifying, { topN: TOP_N });
    return ranked.map((m, i) => ({
        externalId: m.tconst,
        rank: i + 1,
        title: m.title,
    }));
}
