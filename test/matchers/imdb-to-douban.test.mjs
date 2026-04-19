import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { matchImdbToDouban } from '../../src/matchers/imdb-to-douban.mjs';

function mockHttp(handler) {
    return { fetch: async (url, init) => handler(url, init) };
}

const NO_PTGEN = { ptgenMap: null };

test('manual mapping wins over PtGen and search', async () => {
    const http = mockHttp(() => {
        throw new Error('http should not be called when manual override hits');
    });
    const ids = await matchImdbToDouban('tt0110912', http, {
        manualMapping: { imdb: { tt0110912: '1291561' } },
        ptgenMap: new Map([['tt0110912', ['ptgen-value']]]),
    });
    assert.deepEqual(ids, ['1291561']);
});

test('coerces numeric manual mapping value to string', async () => {
    const http = mockHttp(() => {
        throw new Error('unused');
    });
    const ids = await matchImdbToDouban('tt1', http, {
        manualMapping: { imdb: { tt1: 42 } },
        ...NO_PTGEN,
    });
    assert.deepEqual(ids, ['42']);
});

test('PtGen hit returns all dbids (multi-version) without touching search', async () => {
    const http = mockHttp(() => {
        throw new Error('http should not be called when PtGen hits');
    });
    const ptgenMap = new Map([['tt0068646', ['1291841', '34447553']]]);
    const ids = await matchImdbToDouban('tt0068646', http, {
        manualMapping: {},
        ptgenMap,
    });
    assert.deepEqual(ids, ['1291841', '34447553']);
});

test('PtGen miss falls through to search endpoint', async () => {
    const http = mockHttp(async url => {
        assert.equal(
            url,
            'https://search.douban.com/movie/subject_search?search_text=tt0111161',
        );
        return new Response(
            '<a href="https://movie.douban.com/subject/1292052/">Shawshank</a>',
            { status: 200 },
        );
    });
    const ids = await matchImdbToDouban('tt0111161', http, {
        manualMapping: {},
        ptgenMap: new Map(),
    });
    assert.deepEqual(ids, ['1292052']);
});

test('null ptgenMap option also falls through to search', async () => {
    let called = false;
    const http = mockHttp(async () => {
        called = true;
        return new Response(
            '<a href="https://movie.douban.com/subject/9/">X</a>',
            { status: 200 },
        );
    });
    const ids = await matchImdbToDouban('tt1', http, {
        manualMapping: {},
        ...NO_PTGEN,
    });
    assert.deepEqual(ids, ['9']);
    assert.equal(called, true);
});

test('picks the first /subject/ link in the search HTML', async () => {
    const html = `
        <a href="/something/else">Unrelated</a>
        <a href="https://movie.douban.com/subject/9999/">First match</a>
        <a href="https://movie.douban.com/subject/1111/">Later match</a>`;
    const http = mockHttp(async () => new Response(html, { status: 200 }));
    const ids = await matchImdbToDouban('tt1', http, {
        manualMapping: {},
        ...NO_PTGEN,
    });
    assert.deepEqual(ids, ['9999']);
});

test('returns [] when no /subject/ link is in the HTML', async () => {
    const http = mockHttp(
        async () => new Response('<body>no results</body>', { status: 200 }),
    );
    const ids = await matchImdbToDouban('tt9999999', http, {
        manualMapping: {},
        ...NO_PTGEN,
    });
    assert.deepEqual(ids, []);
});

test('returns [] on non-OK search response', async () => {
    const http = mockHttp(async () => new Response('forbidden', { status: 403 }));
    const ids = await matchImdbToDouban('tt1', http, {
        manualMapping: {},
        ...NO_PTGEN,
    });
    assert.deepEqual(ids, []);
});
