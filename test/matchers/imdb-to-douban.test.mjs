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

test('hits search endpoint with the tt id as search_text', async () => {
    const http = mockHttp(async url => {
        assert.equal(
            url,
            'https://search.douban.com/movie/subject_search?search_text=tt0111161',
        );
        return new Response(
            '<div><a href="https://movie.douban.com/subject/1292052/">Shawshank</a></div>',
            { status: 200 },
        );
    });
    const id = await matchImdbToDouban('tt0111161', http, { manualMapping: {} });
    assert.equal(id, '1292052');
});

test('picks the first /subject/ link in the HTML', async () => {
    const html = `
        <html><body>
          <a href="/something/else">Unrelated</a>
          <a href="https://movie.douban.com/subject/9999/">First match</a>
          <a href="https://movie.douban.com/subject/1111/">Later match</a>
        </body></html>`;
    const http = mockHttp(async () => new Response(html, { status: 200 }));
    const id = await matchImdbToDouban('tt1', http, { manualMapping: {} });
    assert.equal(id, '9999');
});

test('returns null when no /subject/ link is in the HTML', async () => {
    const http = mockHttp(
        async () =>
            new Response('<html><body>no results</body></html>', {
                status: 200,
            }),
    );
    const id = await matchImdbToDouban('tt9999999', http, { manualMapping: {} });
    assert.equal(id, null);
});

test('returns null on non-OK HTTP status', async () => {
    const http = mockHttp(async () => new Response('forbidden', { status: 403 }));
    const id = await matchImdbToDouban('tt1', http, { manualMapping: {} });
    assert.equal(id, null);
});
