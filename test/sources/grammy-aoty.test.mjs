import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    assert.equal(source.externalIdKind, 'pre-resolved');
});

test('parseList keeps only winner rows across wikitables', () => {
    const items = parseList(FIXTURE_HTML);
    assert.equal(items.length, 2);
    assert.equal(items[0].externalId, 'grammy-aoty-1970');
    assert.equal(items[0].title, 'Blood, Sweat & Tears');
    assert.equal(items[1].year, '1971');
});

test('scrape() reads snapshot and returns items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grammy-snap-'));
    try {
        const snapshotPath = join(dir, 'snap.json');
        await writeFile(
            snapshotPath,
            JSON.stringify({
                generatedAt: '2026-04-19T00:00:00Z',
                items: [
                    {
                        externalId: 'grammy-aoty-1970',
                        rank: null,
                        title: 'Blood, Sweat & Tears',
                        year: '1970',
                        artist: 'Blood, Sweat & Tears',
                        doubanId: '1401361',
                    },
                ],
            }),
        );
        const http = { fetch: () => { throw new Error('no network'); } };
        const items = await source.scrape(http, { snapshotPath });
        assert.equal(items.length, 1);
        assert.equal(items[0].doubanId, '1401361');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('scrape() throws helpful message when snapshot missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grammy-nosnap-'));
    try {
        const snapshotPath = join(dir, 'missing.json');
        const http = { fetch: () => { throw new Error('unused'); } };
        await assert.rejects(
            () => source.scrape(http, { snapshotPath }),
            /not found.*fetch:grammy-aoty-snapshot/,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('matchItem returns pre-resolved doubanId', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ids = await source.matchItem(
        {
            externalId: 'grammy-aoty-1970',
            rank: null,
            title: 'Blood, Sweat & Tears',
            year: '1970',
            artist: 'Blood, Sweat & Tears',
            doubanId: '1401361',
        },
        http,
        {},
    );
    assert.deepEqual(ids, ['1401361']);
});
