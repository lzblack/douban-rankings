import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { matchImdbToDouban } from '../../src/matchers/imdb-to-douban.mjs';

function mockHttp(handler) {
    return { fetch: async (url, init) => handler(url, init) };
}

test('returns manual mapping without calling http', async () => {
    const http = mockHttp(() => {
        throw new Error('http should not be called when manual override hits');
    });
    const id = await matchImdbToDouban('tt0110912', http, {
        manualMapping: { imdb: { tt0110912: '1291561' } },
    });
    assert.equal(id, '1291561');
});

test('coerces numeric manual mapping value to string', async () => {
    const http = mockHttp(() => {
        throw new Error('unused');
    });
    const id = await matchImdbToDouban('tt1', http, {
        manualMapping: { imdb: { tt1: 42 } },
    });
    assert.equal(id, '42');
});

test('extracts subject id from Douban 302 redirect', async () => {
    const http = mockHttp(async (url, init) => {
        assert.equal(url, 'https://movie.douban.com/imdb/tt0110912/');
        assert.equal(init?.redirect, 'manual');
        return new Response(null, {
            status: 302,
            headers: { location: 'https://movie.douban.com/subject/1291561/' },
        });
    });
    const id = await matchImdbToDouban('tt0110912', http, { manualMapping: {} });
    assert.equal(id, '1291561');
});

test('also accepts 301 redirect', async () => {
    const http = mockHttp(
        async () =>
            new Response(null, {
                status: 301,
                headers: { location: 'https://movie.douban.com/subject/999/' },
            }),
    );
    const id = await matchImdbToDouban('tt1', http, { manualMapping: {} });
    assert.equal(id, '999');
});

test('returns null on non-redirect status', async () => {
    const http = mockHttp(async () => new Response(null, { status: 404 }));
    const id = await matchImdbToDouban('tt9999999', http, { manualMapping: {} });
    assert.equal(id, null);
});

test('returns null when Location header missing', async () => {
    const http = mockHttp(
        async () =>
            new Response(null, { status: 302 /* no Location header */ }),
    );
    const id = await matchImdbToDouban('tt1', http, { manualMapping: {} });
    assert.equal(id, null);
});

test('returns null when Location does not point at /subject/', async () => {
    const http = mockHttp(
        async () =>
            new Response(null, {
                status: 302,
                headers: { location: 'https://movie.douban.com/' },
            }),
    );
    const id = await matchImdbToDouban('tt1', http, { manualMapping: {} });
    assert.equal(id, null);
});
