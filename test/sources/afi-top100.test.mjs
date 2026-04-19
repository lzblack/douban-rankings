import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import source, { parseList } from '../../src/sources/afi-top100.mjs';

const FIXTURE_HTML = `
<table class="wikitable">
  <tr>
    <th>Rank</th><th>Title</th><th>Director</th><th>Year</th><th>Production</th><th>Change</th>
  </tr>
  <tr>
    <td>1.</td>
    <td>Citizen Kane</td>
    <td>Orson Welles</td>
    <td>1941</td>
    <td>RKO Radio Pictures</td>
    <td>—</td>
  </tr>
  <tr>
    <td>2.</td>
    <td>The Godfather</td>
    <td>Francis Ford Coppola</td>
    <td>1972</td>
    <td>Paramount Pictures</td>
    <td>1</td>
  </tr>
  <tr>
    <td>3.</td>
    <td>Casablanca</td>
    <td>Michael Curtiz</td>
    <td>1942[a]</td>
    <td>Warner Bros.</td>
    <td>1</td>
  </tr>
</table>
<table class="wikitable"><!-- subsequent tables should be ignored -->
  <tr><td>99.</td><td>Should Not Parse</td><td>x</td><td>1999</td></tr>
</table>`;

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'afi-top100');
    assert.equal(source.category, 'movie');
    assert.equal(source.kind, 'permanent');
    assert.equal(source.priority, 3);
    assert.equal(source.externalIdKind, 'title-year');
    assert.ok(source.meta.title);
});

test('parseList extracts rank, title, year from first wikitable', () => {
    const items = parseList(FIXTURE_HTML);
    assert.equal(items.length, 3);
    assert.deepEqual(items[0], {
        externalId: 'afi-1',
        rank: 1,
        title: 'Citizen Kane',
        year: '1941',
    });
    assert.equal(items[1].externalId, 'afi-2');
    assert.equal(items[1].year, '1972');
    // year cell "1942[a]" should strip the reference
    assert.equal(items[2].year, '1942');
});

test('parseList throws when wikitable missing', () => {
    assert.throws(
        () => parseList('<html>no table</html>'),
        /wikitable not found/,
    );
});

test('parseList throws when zero rows parsed', () => {
    assert.throws(
        () => parseList('<table class="wikitable"><tr><th>header only</th></tr></table>'),
        /parsed zero rows/,
    );
});

test('scrape() fetches the list URL and parses', async () => {
    let fetchedUrl;
    const fakeHttp = {
        async fetch(url) {
            fetchedUrl = url;
            return new Response(FIXTURE_HTML, { status: 200 });
        },
    };
    const items = await source.scrape(fakeHttp);
    assert.match(fetchedUrl, /AFI.*100_Movies/);
    assert.equal(items.length, 3);
});

test('scrape() throws on non-OK HTTP', async () => {
    const fakeHttp = {
        async fetch() {
            return new Response('x', { status: 503 });
        },
    };
    await assert.rejects(() => source.scrape(fakeHttp), /HTTP 503/);
});

test('matchItem uses ctx.prevResolved and skips remote lookup on cache hit', async () => {
    const http = {
        fetch: () => {
            throw new Error('http should not be called');
        },
    };
    const ctx = {
        prevResolved: new Map([['afi-top100', new Map([['afi-1', ['1292288']]])]]),
    };
    const ids = await source.matchItem(
        { externalId: 'afi-1', rank: 1, title: 'Citizen Kane', year: '1941' },
        http,
        ctx,
    );
    assert.deepEqual(ids, ['1292288']);
});
