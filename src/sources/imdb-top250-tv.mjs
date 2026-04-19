import {
    loadRatings,
    loadTvBasics,
    computeWeightedRanking,
} from '../util/imdb-datasets.mjs';
import { matchImdbToDouban } from '../matchers/imdb-to-douban.mjs';

/**
 * Source: IMDb Top 250 TV Shows.
 *
 * Same Bayesian-weighted-rating approach as IMDb Top 250 Movies, but
 * pulls `titleType ∈ {tvSeries, tvMiniSeries}` from the basics dump
 * and uses a lower vote threshold — TV shows accumulate votes slower
 * than theatrical releases so 25 000 would over-prune.
 *
 * category is `movie` (not `tv`) because Douban hosts TV series as
 * subjects under `movie.douban.com/subject/*` — the same URL pattern
 * as films. `subCategory: 'tv'` lets consumers style TV badges
 * differently if they want.
 */

const TOP_N = 250;
const MIN_VOTES_TV = 5000;

/** @typedef {{ externalId: string, rank: number, title: string }} ScrapedItem */

export default {
    id: 'imdb-top250-tv',
    category: 'movie',
    subCategory: 'tv',
    kind: 'permanent',
    priority: 8,
    externalIdKind: 'imdb',
    meta: {
        title: 'IMDb Top 250 TV Shows',
        titleZh: 'IMDb 剧集 250',
        url: 'https://www.imdb.com/chart/toptv',
    },

    /**
     * @param {{ fetch: Function }} http
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(http) {
        const [ratings, basics] = await Promise.all([
            loadRatings(http),
            loadTvBasics(http),
        ]);
        const qualifying = [];
        for (const b of basics) {
            const r = ratings.get(b.tconst);
            if (!r || r.votes < MIN_VOTES_TV) continue;
            qualifying.push({
                tconst: b.tconst,
                title: b.primaryTitle,
                rating: r.rating,
                votes: r.votes,
            });
        }
        const ranked = computeWeightedRanking(qualifying, {
            minVotes: MIN_VOTES_TV,
            topN: TOP_N,
        });
        return ranked.map((m, i) => ({
            externalId: m.tconst,
            rank: i + 1,
            title: m.title,
        }));
    },

    /**
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} http
     * @param {{ prevResolved?: Map<string, Map<string, string[]>> }} [ctx]
     */
    async matchItem(raw, http, ctx = {}) {
        const cached = ctx.prevResolved?.get('imdb-top250-tv')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return matchImdbToDouban(raw.externalId, http);
    },
};
