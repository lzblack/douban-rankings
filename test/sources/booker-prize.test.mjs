import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import source, { parseList } from '../../src/sources/booker-prize.mjs';

const FIXTURE_HTML = `
<table class="wikitable">
  <tr><th>Year</th><th>Author</th><th>Title</th><th>Genre(s)</th><th>Country</th></tr>
  <tr>
    <td>1969</td>
    <td>P. H. Newby <sup>[64]</sup></td>
    <td>Something to Answer For</td>
    <td>Literary fiction</td>
    <td>ENG</td>
  </tr>
  <tr>
    <td>1971</td>
    <td>V. S. Naipaul <sup>[66]</sup></td>
    <td>In a Free State</td>
    <td>Literary fiction</td>
    <td>UK&nbsp;&nbsp;TTO</td>
  </tr>
</table>
<table class="wikitable"><!-- later wikitables are ignored -->
  <tr><td>2020</td><td>Wrong</td><td>Wrong</td></tr>
</table>`;

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'booker-prize');
    assert.equal(source.category, 'book');
    assert.equal(source.subCategory, 'book');
    assert.equal(source.kind, 'yearly');
    assert.equal(source.priority, 1);
    assert.equal(source.externalIdKind, 'book-title');
});

test('parseList extracts year, author, title from first wikitable; strips wiki refs', () => {
    const items = parseList(FIXTURE_HTML);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
        externalId: 'booker-1969',
        rank: null,
        title: 'Something to Answer For',
        year: '1969',
        author: 'P. H. Newby',
    });
    assert.equal(items[1].externalId, 'booker-1971');
    assert.equal(items[1].author, 'V. S. Naipaul');
});

test('parseList throws on missing wikitable', () => {
    assert.throws(
        () => parseList('<html>no table</html>'),
        /wikitable not found/,
    );
});

test('scrape() fetches list URL and parses', async () => {
    let fetchedUrl;
    const fakeHttp = {
        async fetch(url) {
            fetchedUrl = url;
            return new Response(FIXTURE_HTML, { status: 200 });
        },
    };
    const items = await source.scrape(fakeHttp);
    assert.match(fetchedUrl, /Booker_Prize/);
    assert.equal(items.length, 2);
});

test('matchItem uses ctx.prevResolved cache', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ctx = {
        prevResolved: new Map([
            ['booker-prize', new Map([['booker-1969', ['1005000']]])],
        ]),
    };
    const ids = await source.matchItem(
        {
            externalId: 'booker-1969',
            rank: null,
            title: 'Something to Answer For',
            year: '1969',
            author: 'P. H. Newby',
        },
        http,
        ctx,
    );
    assert.deepEqual(ids, ['1005000']);
});
