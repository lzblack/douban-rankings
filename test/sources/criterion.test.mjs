import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import source, { parseList } from '../../src/sources/criterion.mjs';

const FIXTURE_HTML = `
<table>
  <thead>
    <tr class="gridview__index">
      <th class="g-spine">Spine #</th>
      <th class="g-img"></th>
      <th class="g-title">Title</th>
      <th class="g-director">Director</th>
      <th class="g-country">Country</th>
      <th class="g-year">Year</th>
    </tr>
  </thead>
  <tbody>
    <tr class="gridFilm" data-role="grid-film" data-href="https://www.criterion.com/films/27897-grand-illusion">
      <td class="g-spine">0001</td>
      <td class="g-img"></td>
      <td class="g-title"><span>Grand Illusion</span></td>
      <td class="g-director">Jean Renoir</td>
      <td class="g-country">France</td>
      <td class="g-year">1937</td>
    </tr>
    <tr class="gridFilm" data-role="grid-film" data-href="https://www.criterion.com/films/28097-seven-samurai">
      <td class="g-spine">0002</td>
      <td class="g-img"></td>
      <td class="g-title"><span>Seven Samurai</span></td>
      <td class="g-director">Akira Kurosawa</td>
      <td class="g-country">Japan</td>
      <td class="g-year">1954</td>
    </tr>
    <tr class="gridFilm" data-role="grid-film" data-href="https://www.criterion.com/films/99999-empty-title">
      <td class="g-spine">0003</td>
      <td class="g-img"></td>
      <td class="g-title"></td>
      <td class="g-director">Unknown</td>
      <td class="g-country">Unknown</td>
      <td class="g-year">2000</td>
    </tr>
  </tbody>
</table>`;

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'criterion');
    assert.equal(source.category, 'movie');
    assert.equal(source.kind, 'permanent');
    assert.equal(source.priority, 2);
    assert.equal(source.externalIdKind, 'title-year');
    assert.ok(source.meta.title);
});

test('parseList extracts spine, title, year, slug; skips rows without title', () => {
    const items = parseList(FIXTURE_HTML);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
        externalId: '0001',
        rank: null,
        spineNumber: '0001',
        title: 'Grand Illusion',
        year: '1937',
        slug: 'grand-illusion',
    });
    assert.equal(items[1].externalId, '0002');
    assert.equal(items[1].title, 'Seven Samurai');
    assert.equal(items[1].year, '1954');
});

test('scrape() reads snapshot file when present (no network)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'criterion-snap-'));
    try {
        const snapshotPath = join(dir, 'snap.json');
        await writeFile(
            snapshotPath,
            JSON.stringify({
                generatedAt: '2026-04-18T00:00:00Z',
                items: [
                    { externalId: '0001', rank: null, title: 'A', year: '1937' },
                    { externalId: '0002', rank: null, title: 'B', year: '1954' },
                ],
            }),
        );
        const http = {
            fetch: () => {
                throw new Error('scrape must not touch the network');
            },
        };
        const items = await source.scrape(http, { snapshotPath });
        assert.equal(items.length, 2);
        assert.equal(items[0].externalId, '0001');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('scrape() throws with helpful instructions when snapshot missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'criterion-nosnap-'));
    try {
        const snapshotPath = join(dir, 'does-not-exist.json');
        const http = { fetch: () => { throw new Error('unused'); } };
        await assert.rejects(
            () => source.scrape(http, { snapshotPath }),
            /not found.*fetch:criterion-snapshot/,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('matchItem uses ctx.prevResolved and skips http on cache hit', async () => {
    const http = {
        fetch: () => {
            throw new Error('http should not be called on cache hit');
        },
    };
    const ctx = {
        prevResolved: new Map([
            ['criterion', new Map([['0001', '1294808']])],
        ]),
    };
    const id = await source.matchItem(
        { externalId: '0001', rank: null, title: 'Grand Illusion', year: '1937' },
        http,
        ctx,
    );
    assert.equal(id, '1294808');
});
