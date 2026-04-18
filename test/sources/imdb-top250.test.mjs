import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import source, { computeTop250 } from '../../src/sources/imdb-top250.mjs';

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'imdb-top250');
    assert.equal(source.category, 'movie');
    assert.equal(source.kind, 'permanent');
    assert.equal(source.priority, 1);
    assert.equal(source.externalIdKind, 'imdb');
    assert.ok(source.meta.title);
    assert.ok(source.meta.url.startsWith('https://'));
});

test('computeTop250 ranks by weighted rating and keeps only movies', () => {
    const qualifying = [
        { tconst: 'tt-high', title: 'High', rating: 9.5, votes: 3_000_000 },
        { tconst: 'tt-mid', title: 'Mid', rating: 9.3, votes: 100_000 },
        { tconst: 'tt-broad', title: 'Broad', rating: 8.0, votes: 500_000 },
    ];
    const result = computeTop250(qualifying);
    assert.equal(result.length, 3);
    assert.equal(result[0].externalId, 'tt-high');
    assert.equal(result[0].rank, 1);
    assert.equal(result[0].title, 'High');
    assert.equal(result[2].rank, 3);
});

test('computeTop250 caps output at 250', () => {
    const qualifying = [];
    for (let i = 0; i < 300; i++) {
        qualifying.push({
            tconst: `tt${i}`,
            title: `M${i}`,
            rating: 9 - i * 0.001, // strictly decreasing
            votes: 100_000,
        });
    }
    const result = computeTop250(qualifying);
    assert.equal(result.length, 250);
    assert.equal(result[0].externalId, 'tt0');
    assert.equal(result[249].externalId, 'tt249');
});

test('scrape() fetches both TSVs and filters titleType=movie', async () => {
    const ratingsTsv =
        [
            'tconst\taverageRating\tnumVotes',
            'tt0111161\t9.3\t3000000', // Shawshank
            'tt0068646\t9.2\t2000000', // Godfather
            'tt-tv\t9.5\t1000000', // will be filtered because titleType != movie
            'tt-lowvotes\t10.0\t100', // below MIN_VOTES, filtered at ratings stage
        ].join('\n') + '\n';
    const basicsTsv =
        [
            'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
            'tt0111161\tmovie\tThe Shawshank Redemption\tThe Shawshank Redemption\t0\t1994\t\\N\t142\tDrama',
            'tt0068646\tmovie\tThe Godfather\tThe Godfather\t0\t1972\t\\N\t175\tCrime,Drama',
            'tt-tv\ttvSeries\tAn Ignored Show\tAn Ignored Show\t0\t2008\t2013\t47\tDrama',
        ].join('\n') + '\n';

    const fetchedUrls = [];
    const fakeHttp = {
        async fetch(url) {
            fetchedUrls.push(url);
            const tsv = url.includes('ratings') ? ratingsTsv : basicsTsv;
            return new Response(gzipSync(Buffer.from(tsv)), { status: 200 });
        },
    };

    const items = await source.scrape(fakeHttp);

    assert.deepEqual(fetchedUrls, [
        'https://datasets.imdbws.com/title.ratings.tsv.gz',
        'https://datasets.imdbws.com/title.basics.tsv.gz',
    ]);
    assert.equal(items.length, 2); // tvSeries and low-votes rows dropped
    assert.equal(items[0].externalId, 'tt0111161');
    assert.equal(items[0].rank, 1);
    assert.equal(items[0].title, 'The Shawshank Redemption');
    assert.equal(items[1].externalId, 'tt0068646');
    assert.equal(items[1].rank, 2);
});

test('scrape() throws on non-OK HTTP status', async () => {
    const fakeHttp = {
        async fetch() {
            return new Response('forbidden', { status: 403 });
        },
    };
    await assert.rejects(() => source.scrape(fakeHttp), /HTTP 403/);
});
