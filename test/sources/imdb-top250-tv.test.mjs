import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import source from '../../src/sources/imdb-top250-tv.mjs';
import {
    _resetDatasetsCache,
    RATINGS_URL,
    BASICS_URL,
} from '../../src/util/imdb-datasets.mjs';

beforeEach(() => _resetDatasetsCache());

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'imdb-top250-tv');
    assert.equal(source.category, 'movie');
    assert.equal(source.subCategory, 'tv');
    assert.equal(source.kind, 'permanent');
    assert.equal(source.priority, 8);
    assert.equal(source.externalIdKind, 'imdb');
});

test('scrape() picks tvSeries + tvMiniSeries, rank by weighted rating, filter by MIN_VOTES_TV', async () => {
    const ratingsTsv =
        [
            'tconst\taverageRating\tnumVotes',
            'tt-series-a\t9.5\t500000', // popular series, passes
            'tt-mini-b\t9.3\t80000',   // mini passes
            'tt-low\t10.0\t100',        // below MIN_VOTES_TV (5000)
            'tt-movie-x\t9.2\t1000000', // movie, should be excluded by basics
        ].join('\n') + '\n';
    const basicsTsv =
        [
            'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
            'tt-series-a\ttvSeries\tBreaking Bad\tBreaking Bad\t0\t2008\t2013\t47\tDrama',
            'tt-mini-b\ttvMiniSeries\tChernobyl\tChernobyl\t0\t2019\t2019\t60\tDrama',
            'tt-low\ttvSeries\tObscure Show\tObscure\t0\t2020\t\\N\t30\tDrama',
            'tt-movie-x\tmovie\tSome Movie\tSome Movie\t0\t2010\t\\N\t120\tDrama',
            'tt-episode\ttvEpisode\tEpisode Title\t\\N\t0\t2010\t\\N\t45\tDrama',
        ].join('\n') + '\n';

    const http = {
        async fetch(url) {
            const tsv = url === RATINGS_URL ? ratingsTsv : basicsTsv;
            return new Response(gzipSync(Buffer.from(tsv)), { status: 200 });
        },
    };
    const items = await source.scrape(http);
    assert.equal(items.length, 2);
    assert.equal(items[0].externalId, 'tt-series-a'); // highest WR
    assert.equal(items[0].rank, 1);
    assert.equal(items[1].externalId, 'tt-mini-b');
    assert.equal(items[1].rank, 2);
    // tt-low below threshold filtered out, tt-movie-x wrong type, tt-episode dropped
});

test('matchItem uses ctx.prevResolved cache when present', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ctx = {
        prevResolved: new Map([
            ['imdb-top250-tv', new Map([['tt-series-a', ['1234567']]])],
        ]),
    };
    const ids = await source.matchItem(
        { externalId: 'tt-series-a', rank: 1, title: 'Breaking Bad' },
        http,
        ctx,
    );
    assert.deepEqual(ids, ['1234567']);
});
