import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import source, { parseImdbTop250 } from '../../src/sources/imdb-top250.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(
    join(__dirname, 'fixtures', 'imdb-top250.html'),
    'utf-8',
);

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'imdb-top250');
    assert.equal(source.category, 'movie');
    assert.equal(source.kind, 'permanent');
    assert.equal(source.priority, 1);
    assert.equal(source.externalIdKind, 'imdb');
    assert.ok(source.meta.title);
    assert.ok(source.meta.url.startsWith('https://'));
});

test('parseImdbTop250 extracts tt ids and ranks from JSON-LD', () => {
    const items = parseImdbTop250(fixture);
    assert.equal(items.length, 3);
    assert.deepEqual(items[0], {
        externalId: 'tt0111161',
        rank: 1,
        title: 'The Shawshank Redemption',
    });
    assert.equal(items[1].externalId, 'tt0068646');
    assert.equal(items[2].rank, 3);
});

test('parseImdbTop250 throws when ItemList JSON-LD missing', () => {
    assert.throws(
        () => parseImdbTop250('<html><body>no JSON-LD</body></html>'),
        /ItemList JSON-LD not found/,
    );
});

test('parseImdbTop250 ignores entries without a tt id or position', () => {
    const html = `
    <script type="application/ld+json">
    {"@type":"ItemList","itemListElement":[
      {"@type":"ListItem","position":1,"item":{"url":"https://www.imdb.com/title/tt0111161/","name":"A"}},
      {"@type":"ListItem","position":2,"item":{"url":"https://example.com/not-imdb","name":"B"}},
      {"@type":"ListItem","item":{"url":"https://www.imdb.com/title/tt0000002/","name":"C"}}
    ]}
    </script>`;
    const items = parseImdbTop250(html);
    assert.equal(items.length, 1);
    assert.equal(items[0].externalId, 'tt0111161');
});

test('scrape() fetches the chart URL and returns parsed items', async () => {
    let fetchedUrl;
    const fakeHttp = {
        async fetch(url) {
            fetchedUrl = url;
            return new Response(fixture, { status: 200 });
        },
    };
    const items = await source.scrape(fakeHttp);
    assert.equal(fetchedUrl, 'https://www.imdb.com/chart/top');
    assert.equal(items.length, 3);
});

test('scrape() throws on non-OK HTTP status', async () => {
    const fakeHttp = {
        async fetch() {
            return new Response('forbidden', { status: 403 });
        },
    };
    await assert.rejects(() => source.scrape(fakeHttp), /HTTP 403/);
});
