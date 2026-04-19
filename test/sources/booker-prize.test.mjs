import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    <td>UK</td>
  </tr>
</table>`;

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'booker-prize');
    assert.equal(source.category, 'book');
    assert.equal(source.subCategory, 'book');
    assert.equal(source.kind, 'yearly');
    assert.equal(source.priority, 1);
    assert.equal(source.externalIdKind, 'pre-resolved');
});

test('parseList extracts year/author/title; strips wiki refs', () => {
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
});

test('scrape() reads snapshot and returns items', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'booker-snap-'));
    try {
        const snapshotPath = join(dir, 'snap.json');
        await writeFile(
            snapshotPath,
            JSON.stringify({
                generatedAt: '2026-04-19T00:00:00Z',
                items: [
                    {
                        externalId: 'booker-1969',
                        rank: null,
                        title: 'Something to Answer For',
                        year: '1969',
                        author: 'P. H. Newby',
                        doubanId: '1005000',
                    },
                ],
            }),
        );
        const http = { fetch: () => { throw new Error('no network'); } };
        const items = await source.scrape(http, { snapshotPath });
        assert.equal(items.length, 1);
        assert.equal(items[0].doubanId, '1005000');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('scrape() throws helpful message when snapshot missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'booker-nosnap-'));
    try {
        const snapshotPath = join(dir, 'missing.json');
        const http = { fetch: () => { throw new Error('unused'); } };
        await assert.rejects(
            () => source.scrape(http, { snapshotPath }),
            /not found.*fetch:booker-prize-snapshot/,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('matchItem returns pre-resolved doubanId from snapshot', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ids = await source.matchItem(
        {
            externalId: 'booker-1969',
            rank: null,
            title: 'Something to Answer For',
            year: '1969',
            author: 'P. H. Newby',
            doubanId: '1005000',
        },
        http,
        {},
    );
    assert.deepEqual(ids, ['1005000']);
});
