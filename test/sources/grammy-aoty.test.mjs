import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import source, { parseList } from '../../src/sources/grammy-aoty.mjs';

const FIXTURE_HTML = `
<table class="wikitable">
  <tr><th>Year [a]</th><th>Album</th><th>Artist(s)</th><th>Producer</th></tr>
  <tr>
    <td>1970 [31]</td>
    <td>Blood, Sweat &amp; Tears</td>
    <td>Blood, Sweat &amp; Tears</td>
    <td>James William Guercio, producer</td>
  </tr>
  <tr>
    <td>Abbey Road</td>
    <td>The Beatles</td>
    <td>George Martin, producer</td>
  </tr>
  <tr>
    <td>1971 [32]</td>
    <td>Bridge over Troubled Water</td>
    <td>Simon &amp; Garfunkel</td>
    <td>Producer Name</td>
  </tr>
</table>
<table class="wikitable">
  <tr><th>Artist</th><th>Wins</th></tr>
  <tr><td>Taylor Swift</td><td>4</td></tr>
</table>`;

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'grammy-aoty');
    assert.equal(source.category, 'music');
    assert.equal(source.subCategory, 'album');
    assert.equal(source.kind, 'yearly');
    assert.equal(source.externalIdKind, 'music-title');
});

test('parseList keeps only winner rows (year-bearing) across wikitables', () => {
    const items = parseList(FIXTURE_HTML);
    // 1970 winner + 1971 winner; nominee row without year + aggregate table skipped
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
        externalId: 'grammy-aoty-1970',
        rank: null,
        title: 'Blood, Sweat & Tears',
        year: '1970',
        artist: 'Blood, Sweat & Tears',
    });
    assert.equal(items[1].externalId, 'grammy-aoty-1971');
    assert.equal(items[1].title, 'Bridge over Troubled Water');
    assert.equal(items[1].artist, 'Simon & Garfunkel');
});

test('parseList throws when no winners parsed', () => {
    assert.throws(
        () => parseList('<html>no tables</html>'),
        /parsed zero winners/,
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
    assert.match(fetchedUrl, /Album_of_the_Year/);
    assert.equal(items.length, 2);
});

test('matchItem uses ctx.prevResolved cache', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ctx = {
        prevResolved: new Map([
            ['grammy-aoty', new Map([['grammy-aoty-1970', ['1401361']]])],
        ]),
    };
    const ids = await source.matchItem(
        {
            externalId: 'grammy-aoty-1970',
            rank: null,
            title: 'Blood, Sweat & Tears',
            year: '1970',
            artist: 'Blood, Sweat & Tears',
        },
        http,
        ctx,
    );
    assert.deepEqual(ids, ['1401361']);
});
