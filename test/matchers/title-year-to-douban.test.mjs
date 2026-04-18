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
    const id = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        {
            manualMapping: { titles: { 'grand illusion|1937': '1294808' } },
            ...NO_PTGEN,
        },
    );
    assert.equal(id, '1294808');
});

test('IMDB title index → PtGen layer resolves when both have the title', async () => {
    const basicsTsv =
        [
            'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
            'tt0028950\tmovie\tGrand Illusion\tLa Grande illusion\t0\t1937\t\\N\t113\tDrama',
        ].join('\n') + '\n';
    const http = mockHttp(async url => {
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from(basicsTsv)), { status: 200 });
        }
        // Fallback: any other url should not be called for this happy path
        throw new Error(`unexpected fetch: ${url}`);
    });
    const id = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        {
            manualMapping: {},
            ptgenMap: new Map([['tt0028950', '1294808']]),
        },
    );
    assert.equal(id, '1294808');
});

test('falls through to Douban search when PtGen has no tt', async () => {
    const basicsTsv =
        [
            'tconst\ttitleType\tprimaryTitle\toriginalTitle\tisAdult\tstartYear\tendYear\truntimeMinutes\tgenres',
            'tt0028950\tmovie\tGrand Illusion\tLa Grande illusion\t0\t1937\t\\N\t113\tDrama',
        ].join('\n') + '\n';
    const searchHtml = `<html><script>window.__DATA__ = ${JSON.stringify({
        items: [
            { id: 1294808, title: '大幻影 La grande illusion (1937)' },
            { id: 5048507, title: 'Suuri illusioni (1985)' },
        ],
    })};</script></html>`;

    let searchCalled = false;
    const http = mockHttp(async url => {
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from(basicsTsv)), { status: 200 });
        }
        if (url.includes('search.douban.com')) {
            searchCalled = true;
            return new Response(searchHtml, { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
    });
    const id = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        {
            manualMapping: {},
            ptgenMap: new Map(), // empty — tt is in index but not in PtGen
        },
    );
    assert.equal(id, '1294808');
    assert.ok(searchCalled);
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
        // No basics.tsv.gz served → loadTitleIndex returns empty index
        if (url === BASICS_URL) {
            return new Response(gzipSync(Buffer.from('tconst\ttitleType\n')), {
                status: 200,
            });
        }
        return new Response(searchHtml, { status: 200 });
    });
    const id = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        { manualMapping: {}, ...NO_PTGEN },
    );
    assert.equal(id, '222');
});

test('Douban search accepts ±1 year tolerance when no exact match', async () => {
    const searchHtml = `<html><script>window.__DATA__ = ${JSON.stringify({
        items: [
            { id: 111, title: 'Film A (1920)' },
            { id: 222, title: 'Film B (1938)' }, // ±1 from 1937
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
    const id = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        { manualMapping: {}, ...NO_PTGEN },
    );
    assert.equal(id, '222');
});

test('Douban search returns null when no year match within tolerance', async () => {
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
    const id = await matchTitleYearToDouban(
        { title: 'Grand Illusion', year: '1937' },
        http,
        { manualMapping: {}, ...NO_PTGEN },
    );
    assert.equal(id, null);
});

test('returns null on empty search results', async () => {
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
    const id = await matchTitleYearToDouban(
        { title: 'No Such Film', year: '1900' },
        http,
        { manualMapping: {}, ...NO_PTGEN },
    );
    assert.equal(id, null);
});

test('returns null when missing title', async () => {
    const http = mockHttp(() => {
        throw new Error('unused');
    });
    const id = await matchTitleYearToDouban({ title: '', year: '1937' }, http, {
        manualMapping: {},
        ...NO_PTGEN,
    });
    assert.equal(id, null);
});
