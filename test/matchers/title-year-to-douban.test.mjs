import { test, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { gzipSync } from 'node:zlib';
import {
    matchTitleYearToDouban,
    manualMappingKey,
} from '../../src/matchers/title-year-to-douban.mjs';
import {
    _resetDatasetsCache,
    RATINGS_URL,
    BASICS_URL,
} from '../../src/util/imdb-datasets.mjs';

beforeEach(() => _resetDatasetsCache());

function mockHttp(handler) {
    return { fetch: async (url, init) => handler(url, init) };
}

const NO_PTGEN = { ptgenMap: null };

test('manualMappingKey produces stable normalized form', () => {
    assert.equal(manualMappingKey('Grand Illusion', '1937'), 'grand illusion|1937');
    assert.equal(manualMappingKey("It's a Wonderful Life", 1946), 'its a wonderful life|1946');
    assert.equal(manualMappingKey('Spider-Man', '2002'), 'spider man|2002');
});

test('manual mapping wins over every remote lookup', async () => {
    const http = mockHttp(() => {
        throw new Error('http should not be called');
    });
    const ids = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        {
            manualMapping: { titles: { 'grand illusion|1937': '1294808' } },
            ptgenMap: new Map([['tt0028950', ['ignored']]]),
        },
    );
    assert.deepEqual(ids, ['1294808']);
});

test('IMDB title index → PtGen reverse returns all dbids for the tt', async () => {
    const basicsTsv =
        [
            'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
            'tt0068646\tmovie\tThe Godfather\tThe Godfather\t0\t1972\t\\N\t175\tCrime,Drama',
        ].join('\n') + '\n';
    const http = mockHttp(async url => {
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from(basicsTsv)), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
    const ids = await matchTitleYearToDouban(
        { title: 'The Godfather', year: '1972' },
        http,
        {
            manualMapping: {},
            ptgenMap: new Map([['tt0068646', ['1291841', '34447553']]]),
        },
    );
    assert.deepEqual(ids, ['1291841', '34447553']);
});

test('falls through to Douban search when PtGen has no tt', async () => {
    const basicsTsv =
        [
            'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
            'tt0028950\tmovie\tGrand Illusion\tLa Grande illusion\t0\t1937\t\\N\t113\tDrama',
        ].join('\n') + '\n';
    const searchHtml = `<html><script>window.__DATA__ = ${JSON.stringify({
        items: [{ id: 1294808, title: '大幻影 La grande illusion (1937)' }],
    })};</script></html>`;

    const http = mockHttp(async url => {
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from(basicsTsv)), { status: 200 });
        }
        if (url.includes('search.douban.com')) {
            return new Response(searchHtml, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
    const ids = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        {
            manualMapping: {},
            ptgenMap: new Map(),
        },
    );
    assert.deepEqual(ids, ['1294808']);
});

test('Douban search prefers exact year match, returns first matching item', async () => {
    const searchHtml = `<html><script>window.__DATA__ = ${JSON.stringify({
        items: [
            { id: 111, title: 'Some Other Match (2017)' },
            { id: 222, title: 'Grand Illusion (1937)' },
            { id: 333, title: 'Grand Illusion (1985)' },
        ],
    })};</script></html>`;
    const http = mockHttp(async url => {
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from('tconst\ttitleType\n')), {
                status: 200,
            });
        }
        return new Response(searchHtml, { status: 200 });
    });
    const ids = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        { manualMapping: {}, ...NO_PTGEN },
    );
    assert.deepEqual(ids, ['222']);
});

test('Douban search accepts ±1 year tolerance when no exact match', async () => {
    const searchHtml = `<html><script>window.__DATA__ = ${JSON.stringify({
        items: [
            { id: 111, title: 'Film A (1920)' },
            { id: 222, title: 'Film B (1938)' },
        ],
    })};</script></html>`;
    const http = mockHttp(async url => {
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from('tconst\ttitleType\n')), {
                status: 200,
            });
        }
        return new Response(searchHtml, { status: 200 });
    });
    const ids = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        { manualMapping: {}, ...NO_PTGEN },
    );
    assert.deepEqual(ids, ['222']);
});

test('returns [] when no year match within tolerance', async () => {
    const searchHtml = `<html><script>window.__DATA__ = ${JSON.stringify({
        items: [
            { id: 111, title: 'Unrelated (2010)' },
            { id: 222, title: 'Also Wrong (2020)' },
        ],
    })};</script></html>`;
    const http = mockHttp(async url => {
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from('tconst\ttitleType\n')), {
                status: 200,
            });
        }
        return new Response(searchHtml, { status: 200 });
    });
    const ids = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        { manualMapping: {}, ...NO_PTGEN },
    );
    assert.deepEqual(ids, []);
});

test('returns [] on empty search results', async () => {
    const searchHtml = `<html><script>window.__DATA__ = ${JSON.stringify({
        items: [],
    })};</script></html>`;
    const http = mockHttp(async url => {
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from('tconst\ttitleType\n')), {
                status: 200,
            });
        }
        return new Response(searchHtml, { status: 200 });
    });
    const ids = await matchTitleYearToDouban(
        { title: 'No Such Film', year: '1900' },
        http,
        { manualMapping: {}, ...NO_PTGEN },
    );
    assert.deepEqual(ids, []);
});

test('skipSearchFallback short-circuits after Layer 2 miss', async () => {
    let searchCalled = false;
    const http = mockHttp(async url => {
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from('tconst\ttitleType\n')), {
                status: 200,
            });
        }
        if (url.includes('search.douban.com')) {
            searchCalled = true;
        }
        return new Response('', { status: 200 });
    });
    const ids = await matchTitleYearToDouban(
        { title: 'Unknown', year: '2000' },
        http,
        { manualMapping: {}, ...NO_PTGEN, skipSearchFallback: true },
    );
    assert.deepEqual(ids, []);
    assert.equal(searchCalled, false);
});

test('returns [] when missing title', async () => {
    const http = mockHttp(() => {
        throw new Error('unused');
    });
    const ids = await matchTitleYearToDouban({ title: '', year: '1937' }, http, {
        manualMapping: {},
        ...NO_PTGEN,
    });
    assert.deepEqual(ids, []);
});
