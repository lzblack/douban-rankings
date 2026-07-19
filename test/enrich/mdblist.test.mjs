import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
    collectImdbTargets,
    selectStale,
    normalizeMdblistResponse,
    fetchRatings,
    injectRatings,
    orderByStaleness,
    enrichPayload,
} from '../../src/enrich/mdblist.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = name =>
    JSON.parse(readFileSync(join(HERE, 'fixtures', name), 'utf-8'));
const MOVIE = fixture('mdblist-movie-tt0111161.json'); // Shawshank
const SHOW = fixture('mdblist-show-tt0903747.json'); // Breaking Bad

const NOW = new Date('2026-07-19T04:00:00Z');

function movieFixture(items, { ratings, sources } = {}) {
    const cat = {
        sources: sources ?? { 'imdb-top250': { subCategory: 'movie' } },
        items,
    };
    if (ratings) cat.ratings = ratings;
    return { schemaVersion: 1, categories: { movie: cat } };
}

// --- collectImdbTargets ---------------------------------------------------

test('collectImdbTargets keeps only tt-backed entries, tagging kind=movie', () => {
    const json = movieFixture({
        1292052: [{ source: 'imdb-top250', rank: 1, externalId: 'tt0111161' }],
        1234567: [{ source: 'criterion', rank: null, externalId: '1056' }],
        7654321: [{ source: 'afi-top100', rank: 5, externalId: 'Casablanca|1942' }],
    });
    const targets = collectImdbTargets(json);
    assert.deepEqual([...targets.keys()], ['tt0111161']);
    assert.deepEqual(targets.get('tt0111161'), {
        doubanIds: ['1292052'],
        kind: 'movie',
    });
});

test('collectImdbTargets tags kind=show when the source subCategory is tv', () => {
    const json = movieFixture(
        { 26794435: [{ source: 'imdb-top250-tv', rank: 1, externalId: 'tt0903747' }] },
        { sources: { 'imdb-top250-tv': { subCategory: 'tv' } } },
    );
    assert.deepEqual(collectImdbTargets(json).get('tt0903747'), {
        doubanIds: ['26794435'],
        kind: 'show',
    });
});

test('collectImdbTargets dedups one tt across multiple doubanIds (sorted)', () => {
    const json = movieFixture({
        26934: [{ source: 'tspdt-1000', rank: 3, externalId: 'tt0064116' }],
        1301392: [{ source: 'letterboxd-top250', rank: 9, externalId: 'tt0064116' }],
    });
    assert.deepEqual(collectImdbTargets(json).get('tt0064116').doubanIds, [
        '1301392',
        '26934',
    ]);
});

test('collectImdbTargets returns empty on empty items', () => {
    assert.equal(collectImdbTargets(movieFixture({})).size, 0);
});

// --- selectStale ----------------------------------------------------------

const T = (doubanIds, kind = 'movie') => ({ doubanIds, kind });

test('selectStale returns tts with missing ratings', () => {
    const targets = new Map([
        ['tt0111161', T(['1292052'])],
        ['tt0068646', T(['1291841'])],
    ]);
    assert.deepEqual(
        selectStale(targets, {}, { ttlMs: 90 * 864e5, now: NOW }),
        ['tt0068646', 'tt0111161'],
    );
});

test('selectStale skips fresh ratings and re-includes expired ones', () => {
    const targets = new Map([['tt_fresh', T(['100'])], ['tt_old', T(['200'])]]);
    const prev = {
        100: { imdb: 80, at: '2026-07-18T04:00:00Z' }, // 1 day old
        200: { imdb: 70, at: '2026-01-01T04:00:00Z' }, // ~200 days old
    };
    assert.deepEqual(
        selectStale(targets, prev, { ttlMs: 90 * 864e5, now: NOW }),
        ['tt_old'],
    );
});

test('selectStale treats an unparseable timestamp as stale', () => {
    const targets = new Map([['tt_bad', T(['300'])]]);
    assert.deepEqual(
        selectStale(targets, { 300: { imdb: 60, at: 'nope' } }, { ttlMs: 90 * 864e5, now: NOW }),
        ['tt_bad'],
    );
});

test('selectStale marks a tt stale if ANY of its doubanIds is stale', () => {
    const targets = new Map([['tt_multi', T(['100', '200'])]]);
    const prev = { 100: { imdb: 80, at: '2026-07-18T04:00:00Z' } }; // 200 missing
    assert.deepEqual(
        selectStale(targets, prev, { ttlMs: 90 * 864e5, now: NOW }),
        ['tt_multi'],
    );
});

test('selectStale rejects a non-positive ttl', () => {
    assert.throws(() => selectStale(new Map(), {}, { ttlMs: 0, now: NOW }), /ttlMs/);
});

test('selectStale rechecks a negative sentinel on the shorter negative TTL', () => {
    const targets = new Map([['tt_neg', T(['1'])], ['tt_pos', T(['2'])]]);
    const prev = {
        1: { at: '2026-06-19T04:00:00Z' }, // sentinel, 30 days old
        2: { imdb: 80, at: '2026-06-19T04:00:00Z' }, // real score, 30 days old
    };
    // ttl 90d (both within) but negativeTtl 20d → the sentinel is stale, the real one fresh
    const stale = selectStale(targets, prev, {
        ttlMs: 90 * 864e5,
        negativeTtlMs: 20 * 864e5,
        now: NOW,
    });
    assert.deepEqual(stale, ['tt_neg']);
});

// --- normalizeMdblistResponse (real fixtures) -----------------------------

test('normalizeMdblistResponse maps slugs and drops null/unknown sources (movie)', () => {
    const r = normalizeMdblistResponse(MOVIE);
    assert.deepEqual(r, {
        imdb: 93,
        metacritic: 82,
        rt: 89, // tomatoes
        rtAudience: 98, // popcorn
        tmdb: 87,
        letterboxd: 92,
    });
    // metacriticuser/trakt not in our map; rogerebert/myanimelist score null → dropped
    assert.equal('trakt' in r, false);
    assert.equal('rogerebert' in r, false);
});

test('normalizeMdblistResponse omits letterboxd for a show with null score', () => {
    const r = normalizeMdblistResponse(SHOW);
    assert.equal('letterboxd' in r, false); // Breaking Bad has letterboxd score null
    assert.equal(r.imdb, 95);
    assert.equal(r.rtAudience, 97);
});

test('normalizeMdblistResponse tolerates missing/garbage ratings arrays', () => {
    assert.deepEqual(normalizeMdblistResponse({}), {});
    assert.deepEqual(normalizeMdblistResponse({ ratings: null }), {});
    assert.deepEqual(
        normalizeMdblistResponse({ ratings: [{ source: 'tomatoesaudience', score: 77 }] }),
        { rtAudience: 77 }, // legacy slug accepted
    );
});

// --- fetchRatings (fake http, no network) ---------------------------------

function respond(status, body) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
    });
}
function fakeHttp(handler) {
    return { fetch: async url => handler(url) };
}

test('fetchRatings queries /movie/ for a movie hint and normalizes', async () => {
    const calls = [];
    const http = fakeHttp(url => {
        calls.push(url);
        return respond(200, MOVIE);
    });
    const r = await fetchRatings('tt0111161', 'movie', { http, key: 'K' });
    assert.equal(r.imdb, 93);
    assert.equal(r.rtAudience, 98);
    assert.match(calls[0], /\/imdb\/movie\/tt0111161\?/);
    assert.equal(calls.length, 1); // no fallback needed
});

test('fetchRatings falls back to /show/ when /movie/ 404s', async () => {
    const calls = [];
    const http = fakeHttp(url => {
        calls.push(url);
        if (url.includes('/movie/')) return respond(404, { error: 'Item not found' });
        return respond(200, SHOW);
    });
    // even with a 'movie' hint, a 404 should retry as show
    const r = await fetchRatings('tt0903747', 'movie', { http, key: 'K' });
    assert.equal(r.imdb, 95);
    assert.equal(calls.length, 2);
    assert.match(calls[0], /\/movie\//);
    assert.match(calls[1], /\/show\//);
});

test('fetchRatings tries /show/ first for a show hint', async () => {
    const calls = [];
    const http = fakeHttp(url => {
        calls.push(url);
        return respond(200, SHOW);
    });
    await fetchRatings('tt0903747', 'show', { http, key: 'K' });
    assert.match(calls[0], /\/show\//);
    assert.equal(calls.length, 1);
});

test('fetchRatings returns {} (definitive absent) when 404 under both types', async () => {
    const http = fakeHttp(() => respond(404, { error: 'Item not found' }));
    assert.deepEqual(await fetchRatings('tt9999999', 'movie', { http, key: 'K' }), {});
});

test('fetchRatings returns null (transient) on 429/5xx, not a false absent', async () => {
    const http429 = fakeHttp(() => respond(429, 'rate limited'));
    assert.equal(await fetchRatings('tt0111161', 'movie', { http: http429, key: 'K' }), null);
    const http500 = fakeHttp(() => respond(500, 'server error'));
    assert.equal(await fetchRatings('tt0111161', 'movie', { http: http500, key: 'K' }), null);
});

test('fetchRatings never puts the key in the path, only the query', async () => {
    let seen;
    const http = fakeHttp(url => {
        seen = url;
        return respond(200, MOVIE);
    });
    await fetchRatings('tt0111161', 'movie', { http, key: 'super-secret' });
    assert.match(seen, /apikey=super-secret/);
    assert.equal(seen.split('?')[0].includes('super-secret'), false);
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
    assert.deepEqual(out.categories.movie.items, json.categories.movie.items);
    assert.deepEqual(out.categories.movie.sources, json.categories.movie.sources);
    assert.equal(out.schemaVersion, 1);
});

test('injectRatings preserves prior ratings not in the new batch', () => {
    const json = movieFixture(
        { 1292052: [{ source: 'imdb-top250', rank: 1, externalId: 'tt0111161' }] },
        { ratings: { 999: { imdb: 55, at: '2026-07-01T00:00:00.000Z' } } },
    );
    const out = injectRatings(json, { 1292052: { imdb: 78 } }, { now: NOW });
    assert.equal(out.categories.movie.ratings['999'].imdb, 55);
    assert.equal(out.categories.movie.ratings['1292052'].imdb, 78);
});

test('injectRatings writes an {at}-only negative sentinel for empty scores', () => {
    const json = movieFixture({
        1292052: [{ source: 'imdb-top250', rank: 1, externalId: 'tt0111161' }],
    });
    const out = injectRatings(json, { 1292052: {}, 1291841: { imdb: 90 } }, { now: NOW });
    // empty → sentinel (present, but only `at`), not skipped
    assert.deepEqual(out.categories.movie.ratings['1292052'], {
        at: '2026-07-19T04:00:00.000Z',
    });
    assert.equal(out.categories.movie.ratings['1291841'].imdb, 90);
    assert.notEqual(out, json);
    assert.equal(json.categories.movie.ratings, undefined);
});

// --- orderByStaleness -----------------------------------------------------

test('orderByStaleness puts missing first, then oldest→newest', () => {
    const targets = new Map([
        ['tt_new', T(['1'])],
        ['tt_missing', T(['2'])],
        ['tt_old', T(['3'])],
    ]);
    const prev = {
        1: { at: '2026-07-18T00:00:00Z' }, // newest
        3: { at: '2026-01-01T00:00:00Z' }, // oldest
        // 2 missing
    };
    assert.deepEqual(orderByStaleness(['tt_new', 'tt_missing', 'tt_old'], targets, prev), [
        'tt_missing',
        'tt_old',
        'tt_new',
    ]);
});

// --- enrichPayload (fake http orchestration) ------------------------------

function enrichFixtureJson() {
    return movieFixture(
        {
            1: [{ source: 'imdb-top250', rank: 1, externalId: 'tt0111161' }],
            2: [{ source: 'imdb-top250-tv', rank: 1, externalId: 'tt0903747' }],
            3: [{ source: 'imdb-top250', rank: 2, externalId: 'tt0000009' }], // MDBList miss
            4: [{ source: 'criterion', rank: null, externalId: '1056' }], // non-tt, ignored
        },
        {
            sources: {
                'imdb-top250': { subCategory: 'movie' },
                'imdb-top250-tv': { subCategory: 'tv' },
                criterion: { subCategory: 'movie' },
            },
        },
    );
}

function routedHttp(calls) {
    return {
        fetch: async url => {
            calls.push(url);
            if (url.includes('tt0111161')) return respond(200, MOVIE);
            if (url.includes('/show/tt0903747')) return respond(200, SHOW);
            return respond(404, { error: 'Item not found' }); // tt0000009
        },
    };
}

test('enrichPayload fetches tt-backed titles, routes show, and summarizes', async () => {
    const calls = [];
    const { payload, summary } = await enrichPayload(enrichFixtureJson(), {
        http: routedHttp(calls),
        key: 'K',
        ttlMs: 90 * 864e5,
        now: NOW,
    });
    const ratings = payload.categories.movie.ratings;
    assert.equal(ratings['1'].imdb, 93); // movie
    assert.equal(ratings['2'].imdb, 95); // show routed to /show/
    assert.deepEqual(Object.keys(ratings['3']), ['at']); // MDBList miss → negative sentinel
    assert.equal('4' in ratings, false); // non-tt never targeted
    assert.deepEqual(summary, {
        ttTargets: 3,
        fresh: 0,
        stale: 3,
        attempted: 3,
        requests: 4, // hit+hit = 2, miss (movie 404 → show 404) = 2
        withRatings: 2,
        noData: 1,
        errored: 0,
        skippedByCap: 0,
    });
});

test('enrichPayload caps on HTTP requests (not titles) and reports the remainder', async () => {
    const calls = [];
    const { summary } = await enrichPayload(enrichFixtureJson(), {
        http: routedHttp(calls),
        key: 'K',
        ttlMs: 90 * 864e5,
        maxRequests: 4, // miss(2) + one hit(1) = 3 used; next title needs 2 → stop
        now: NOW,
    });
    assert.equal(summary.attempted, 2);
    assert.equal(summary.requests, 3);
    assert.equal(summary.skippedByCap, 1);
});

test('enrichPayload negative-caches misses so a second run does not refetch them', async () => {
    const first = await enrichPayload(enrichFixtureJson(), {
        http: routedHttp([]),
        key: 'K',
        ttlMs: 90 * 864e5,
        negativeTtlMs: 30 * 864e5,
        now: NOW,
    });
    assert.deepEqual(Object.keys(first.payload.categories.movie.ratings['3']), ['at']);

    const calls2 = [];
    const second = await enrichPayload(first.payload, {
        http: routedHttp(calls2),
        key: 'K',
        ttlMs: 90 * 864e5,
        negativeTtlMs: 30 * 864e5,
        now: new Date('2026-07-25T04:00:00Z'), // 6 days later, within both TTLs
    });
    assert.equal(second.summary.stale, 0); // sentinel counts as fresh
    assert.equal(calls2.length, 0); // zero network on the re-run
});

test('enrichPayload does NOT negative-cache a transient (quota/5xx) failure', async () => {
    const quotaHttp = { fetch: async () => respond(429, 'rate limited') };
    const json = movieFixture(
        { 5: [{ source: 'imdb-top250', rank: 1, externalId: 'tt0111161' }] },
        { sources: { 'imdb-top250': { subCategory: 'movie' } } },
    );
    const { payload, summary } = await enrichPayload(json, {
        http: quotaHttp,
        key: 'K',
        ttlMs: 90 * 864e5,
        now: NOW,
    });
    assert.equal(summary.errored, 1);
    assert.equal(summary.noData, 0);
    // no entry written → still stale next run (no false sentinel)
    assert.equal(payload.categories.movie.ratings?.['5'], undefined);
    const restale = selectStale(collectImdbTargets(payload), payload.categories.movie.ratings ?? {}, {
        ttlMs: 90 * 864e5,
        now: NOW,
    });
    assert.deepEqual(restale, ['tt0111161']); // retried next run
});

test('enrichPayload skips titles whose ratings are still fresh', async () => {
    const json = enrichFixtureJson();
    json.categories.movie.ratings = {
        1: { imdb: 90, at: '2026-07-18T04:00:00Z' }, // fresh
        2: { imdb: 90, at: '2026-07-18T04:00:00Z' }, // fresh
    };
    const calls = [];
    const { summary } = await enrichPayload(json, {
        http: routedHttp(calls),
        key: 'K',
        ttlMs: 90 * 864e5,
        now: NOW,
    });
    // only tt0000009 (doubanId 3) is stale/missing
    assert.equal(summary.fresh, 2);
    assert.equal(summary.stale, 1);
    assert.equal(calls.length, 2); // tt0000009: /movie/ 404 → /show/ 404
});
