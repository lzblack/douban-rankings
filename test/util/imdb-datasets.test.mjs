import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import {
    loadRatings,
    loadMovieBasics,
    loadTitleIndex,
    normalizeTitle,
    computeWeightedRanking,
    _resetDatasetsCache,
    RATINGS_URL,
    BASICS_URL,
} from '../../src/util/imdb-datasets.mjs';

beforeEach(() => _resetDatasetsCache());

function fakeHttpFromTsv({ ratingsTsv = '', basicsTsv = '' } = {}) {
    return {
        async fetch(url) {
            const tsv = url === RATINGS_URL ? ratingsTsv : basicsTsv;
            return new Response(gzipSync(Buffer.from(tsv)), { status: 200 });
        },
    };
}

const MIN_RATINGS_TSV =
    [
        'tconst\taverageRating\tnumVotes',
        'tt1\t9.0\t100000',
        'tt2\t8.0\t10', // below threshold
    ].join('\n') + '\n';

const MIN_BASICS_TSV =
    [
        'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
        'tt1\tmovie\tMy Film\tMon Film\t0\t2001\t\\N\t100\tDrama',
        'tt2\ttvSeries\tA Show\tA Show\t0\t2005\t2010\t45\tDrama',
        'tt3\tmovie\tAnother Movie\t\\N\t0\t2010\t\\N\t120\tComedy',
        'tt-noyear\tmovie\tNo Year Film\tNo Year Film\t0\t\\N\t\\N\t90\tDrama',
    ].join('\n') + '\n';

test('loadRatings returns all positive-vote ratings and caches', async () => {
    const http = fakeHttpFromTsv({ ratingsTsv: MIN_RATINGS_TSV });
    const r1 = await loadRatings(http);
    // Source-level vote filtering is each source's responsibility; this
    // loader returns everything with votes > 0 so multiple sources can
    // share the cache with different thresholds.
    assert.equal(r1.size, 2);
    assert.deepEqual(r1.get('tt1'), { rating: 9.0, votes: 100000 });
    assert.deepEqual(r1.get('tt2'), { rating: 8.0, votes: 10 });
    const r2 = await loadRatings(http);
    assert.equal(r1, r2);
});

test('loadMovieBasics returns only titleType=movie rows', async () => {
    const http = fakeHttpFromTsv({ basicsTsv: MIN_BASICS_TSV });
    const basics = await loadMovieBasics(http);
    assert.equal(basics.length, 3); // tt1, tt3, tt-noyear (tvSeries dropped)
    const tconsts = basics.map(b => b.tconst).sort();
    assert.deepEqual(tconsts, ['tt-noyear', 'tt1', 'tt3']);
    const tt1 = basics.find(b => b.tconst === 'tt1');
    assert.equal(tt1.primaryTitle, 'My Film');
    assert.equal(tt1.originalTitle, 'Mon Film');
    assert.equal(tt1.year, '2001');
});

test('loadMovieBasics normalizes \\N year to empty string', async () => {
    const http = fakeHttpFromTsv({ basicsTsv: MIN_BASICS_TSV });
    const basics = await loadMovieBasics(http);
    const noYear = basics.find(b => b.tconst === 'tt-noyear');
    assert.equal(noYear.year, '');
});

test('loadTitleIndex builds (normalizedTitle|year → tt) and dedupes against both titles', async () => {
    const http = fakeHttpFromTsv({ basicsTsv: MIN_BASICS_TSV });
    const index = await loadTitleIndex(http);
    // primaryTitle "My Film" + "2001" → tt1
    assert.equal(index.get('my film|2001'), 'tt1');
    // originalTitle "Mon Film" + "2001" → tt1 too (same tt, different title)
    assert.equal(index.get('mon film|2001'), 'tt1');
    // originalTitle \N is skipped, only primaryTitle indexed
    assert.equal(index.get('another movie|2010'), 'tt3');
    // rows without year are skipped entirely
    assert.equal(index.get('no year film|'), undefined);
});

test('normalizeTitle: lowercase, & → and, strip punctuation, collapse spaces', () => {
    assert.equal(normalizeTitle('The Lord of the Rings: The Two Towers'), 'the lord of the rings the two towers');
    assert.equal(normalizeTitle('Lilo & Stitch'), 'lilo and stitch');
    assert.equal(normalizeTitle("It's a Wonderful Life"), 'its a wonderful life');
    assert.equal(normalizeTitle('Spider-Man'), 'spider man');
    assert.equal(normalizeTitle('  extra   spaces  '), 'extra spaces');
});

test('normalizeTitle preserves accented characters', () => {
    assert.equal(normalizeTitle('Amélie'), 'amélie');
    assert.equal(normalizeTitle('Pan\u2019s Labyrinth'), 'pans labyrinth');
});

test('computeWeightedRanking sorts by Bayesian score and respects topN', () => {
    const input = [
        { tconst: 'a', rating: 9.5, votes: 3_000_000 },
        { tconst: 'b', rating: 9.3, votes: 100_000 },
        { tconst: 'c', rating: 8.0, votes: 500_000 },
    ];
    const ranked = computeWeightedRanking(input, { topN: 2 });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].tconst, 'a'); // highest votes × rating combo
});
