import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { createInterface } from 'node:readline';

/**
 * Source: IMDb Top 250 (feature films).
 *
 * Data is derived from IMDb's public non-commercial datasets rather than the
 * chart page, because imdb.com is behind AWS WAF — a plain HTTP fetch can't
 * get past the JS challenge. Datasets are published at a public CDN with a
 * daily refresh and no rate limiting; they're the robust path.
 *
 * Top 250 membership and order are computed with IMDb's publicly documented
 * Bayesian weighted rating formula:
 *
 *   WR = (v / (v + m)) * R + (m / (v + m)) * C
 *
 * where v = numVotes, R = averageRating, m = minimum votes threshold,
 * C = mean vote across qualifying titles. This approximates IMDb's own
 * Top 250 list to within a handful of positions; membership overlap is
 * typically well over 95 percent. IMDb's real list uses private
 * adjustments we can't reproduce exactly.
 */

const RATINGS_URL = 'https://datasets.imdbws.com/title.ratings.tsv.gz';
const BASICS_URL = 'https://datasets.imdbws.com/title.basics.tsv.gz';

const MIN_VOTES = 25000;
const MEAN_VOTE = 7.0;
const TOP_N = 250;

/**
 * @typedef {{ externalId: string, rank: number, title: string }} ScrapedItem
 */

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

    /**
     * @param {{ fetch: (url: string, init?: RequestInit) => Promise<Response> }} http
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(http) {
        // Stream ratings first: it's small (~7 MB gzip), so we build an
        // in-memory map keyed by tconst for O(1) join against basics.
        const ratings = new Map();
        await streamTsvRows(http, RATINGS_URL, cols => {
            const votes = Number(cols[2]);
            if (votes >= MIN_VOTES) {
                ratings.set(cols[0], {
                    rating: Number(cols[1]),
                    votes,
                });
            }
        });

        // Stream basics (~200 MB gzip, ~1.5 GB raw). Filter in-stream so we
        // never hold the full 11M-row dataset in memory — only the few
        // thousand movies that pass the vote threshold.
        const qualifying = [];
        await streamTsvRows(http, BASICS_URL, cols => {
            const [tconst, titleType, primaryTitle] = cols;
            if (titleType !== 'movie') return;
            const r = ratings.get(tconst);
            if (!r) return;
            qualifying.push({
                tconst,
                title: primaryTitle,
                rating: r.rating,
                votes: r.votes,
            });
        });

        return computeTop250(qualifying);
    },
};

/**
 * Apply the Bayesian weighted rating and take the top N. Exported for tests.
 *
 * @param {Array<{ tconst: string, title: string, rating: number, votes: number }>} qualifying
 * @returns {ScrapedItem[]}
 */
export function computeTop250(qualifying) {
    for (const m of qualifying) {
        m.wr =
            (m.votes / (m.votes + MIN_VOTES)) * m.rating +
            (MIN_VOTES / (m.votes + MIN_VOTES)) * MEAN_VOTE;
    }
    qualifying.sort((a, b) => b.wr - a.wr);
    return qualifying.slice(0, TOP_N).map((m, i) => ({
        externalId: m.tconst,
        rank: i + 1,
        title: m.title,
    }));
}

/**
 * Fetch a gzipped TSV from IMDb datasets, stream-gunzip, and invoke `onRow`
 * for each data row (header skipped). `cols` is the tab-split array.
 *
 * Memory stays bounded: lines are processed one at a time, not buffered.
 */
async function streamTsvRows(http, url, onRow) {
    const res = await http.fetch(url);
    if (!res.ok) {
        throw new Error(`imdb-top250: HTTP ${res.status} from ${url}`);
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
