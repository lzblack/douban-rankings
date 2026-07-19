import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
    collectImdbTargets,
    selectStale,
    injectRatings,
} from '../../src/enrich/mdblist.mjs';

const NOW = new Date('2026-07-19T04:00:00Z');

function movieFixture(items, ratings) {
    const cat = { sources: { 'imdb-top250': { itemCount: 1 } }, items };
    if (ratings) cat.ratings = ratings;
    return {
        schemaVersion: 1,
        generatedAt: '2026-07-01T00:00:00.000Z',
        categories: { movie: cat },
    };
}

// --- collectImdbTargets ---------------------------------------------------

test('collectImdbTargets keeps only tt-backed entries, skipping non-imdb sources', () => {
    const json = movieFixture({
        1292052: [{ source: 'imdb-top250', rank: 1, externalId: 'tt0111161' }],
        1234567: [{ source: 'criterion', rank: null, externalId: '1056' }],
        7654321: [{ source: 'afi-top100', rank: 5, externalId: 'Casablanca|1942' }],
    });
    const targets = collectImdbTargets(json);
    assert.ok(targets instanceof Map);
    assert.deepEqual([...targets.keys()], ['tt0111161']);
    assert.deepEqual(targets.get('tt0111161'), ['1292052']);
});

test('collectImdbTargets dedups one tt across multiple doubanIds (multi-version)', () => {
    const json = movieFixture({
        26934: [{ source: 'tspdt-1000', rank: 3, externalId: 'tt0064116' }],
        1301392: [{ source: 'letterboxd-top250', rank: 9, externalId: 'tt0064116' }],
    });
    const targets = collectImdbTargets(json);
    assert.deepEqual(targets.get('tt0064116'), ['1301392', '26934']); // sorted
});

test('collectImdbTargets tolerates a doubanId with multiple entries and empty items', () => {
    assert.equal(collectImdbTargets(movieFixture({})).size, 0);
    const json = movieFixture({
        1292052: [
            { source: 'imdb-top250', rank: 1, externalId: 'tt0111161' },
            { source: 'letterboxd-top250', rank: 4, externalId: 'tt0111161' },
        ],
    });
    assert.deepEqual([...collectImdbTargets(json).get('tt0111161')], ['1292052']);
});

// --- selectStale ----------------------------------------------------------

test('selectStale returns tts with missing ratings', () => {
    const targets = new Map([['tt0111161', ['1292052']], ['tt0068646', ['1291841']]]);
    const stale = selectStale(targets, {}, { ttlMs: 30 * 864e5, now: NOW });
    assert.deepEqual(stale, ['tt0068646', 'tt0111161']);
});

test('selectStale skips fresh ratings and re-includes expired ones', () => {
    const targets = new Map([['tt_fresh', ['100']], ['tt_old', ['200']]]);
    const prev = {
        100: { imdb: 80, at: '2026-07-18T04:00:00Z' }, // 1 day old
        200: { imdb: 70, at: '2026-05-01T04:00:00Z' }, // ~79 days old
    };
    const stale = selectStale(targets, prev, { ttlMs: 30 * 864e5, now: NOW });
    assert.deepEqual(stale, ['tt_old']);
});

test('selectStale treats an unparseable timestamp as stale', () => {
    const targets = new Map([['tt_bad', ['300']]]);
    const stale = selectStale(targets, { 300: { imdb: 60, at: 'not-a-date' } }, {
        ttlMs: 30 * 864e5,
        now: NOW,
    });
    assert.deepEqual(stale, ['tt_bad']);
});

test('selectStale marks a tt stale if ANY of its doubanIds is stale', () => {
    const targets = new Map([['tt_multi', ['100', '200']]]);
    const prev = { 100: { imdb: 80, at: '2026-07-18T04:00:00Z' } }; // 200 missing
    const stale = selectStale(targets, prev, { ttlMs: 30 * 864e5, now: NOW });
    assert.deepEqual(stale, ['tt_multi']);
});

test('selectStale rejects a non-positive ttl', () => {
    assert.throws(() => selectStale(new Map(), {}, { ttlMs: 0, now: NOW }), /ttlMs/);
});

// --- injectRatings --------------------------------------------------------

test('injectRatings adds an additive ratings map stamped with `at`', () => {
    const json = movieFixture({
        1292052: [{ source: 'imdb-top250', rank: 1, externalId: 'tt0111161' }],
    });
    const out = injectRatings(json, { 1292052: { imdb: 78, rt: 91 } }, { now: NOW });

    assert.deepEqual(out.categories.movie.ratings['1292052'], {
        imdb: 78,
        rt: 91,
        at: '2026-07-19T04:00:00.000Z',
    });
    // additive: schemaVersion + sources + items untouched
    assert.equal(out.categories.movie.schemaVersion ?? out.schemaVersion, 1);
    assert.deepEqual(out.categories.movie.items, json.categories.movie.items);
    assert.deepEqual(out.categories.movie.sources, json.categories.movie.sources);
});

test('injectRatings preserves prior ratings not in the new batch', () => {
    const json = movieFixture(
        { 1292052: [{ source: 'imdb-top250', rank: 1, externalId: 'tt0111161' }] },
        { 999: { imdb: 55, at: '2026-07-01T00:00:00.000Z' } },
    );
    const out = injectRatings(json, { 1292052: { imdb: 78 } }, { now: NOW });
    assert.equal(out.categories.movie.ratings['999'].imdb, 55); // preserved
    assert.equal(out.categories.movie.ratings['1292052'].imdb, 78); // added
});

test('injectRatings skips empty score objects and returns a new object', () => {
    const json = movieFixture({
        1292052: [{ source: 'imdb-top250', rank: 1, externalId: 'tt0111161' }],
    });
    const out = injectRatings(json, { 1292052: {}, 1291841: { imdb: 90 } }, { now: NOW });
    assert.equal('1292052' in out.categories.movie.ratings, false);
    assert.equal(out.categories.movie.ratings['1291841'].imdb, 90);
    assert.notEqual(out, json); // new object, input not mutated
    assert.equal(json.categories.movie.ratings, undefined);
});
