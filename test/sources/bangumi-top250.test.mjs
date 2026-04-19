import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import source, { parseList } from '../../src/sources/bangumi-top250.mjs';

const FIXTURE_HTML = `
<ul class="browserList">
  <li id="item_253" class="item">
    <h3>
      <a href="/subject/253" class="l">星际牛仔</a>
      <small class="grey">Cowboy Bebop</small>
    </h3>
    <span class="rank">Rank <b>4</b></span>
    <p class="info tip">26话 / 1998年4月3日 / 渡辺信一郎 / サンライズ</p>
  </li>
  <li id="item_4">
    <h3>
      <a href="/subject/4" class="l">攻壳机动队 S.A.C. 2nd GIG</a>
      <small class="grey">攻殻機動隊 S.A.C. 2nd GIG</small>
    </h3>
    <span class="rank">Rank <b>1</b></span>
    <p class="info tip">26话 / 2004年1月1日 / 神山健治 / Production I.G</p>
  </li>
  <li id="item_noyear">
    <h3>
      <a href="/subject/999" class="l">Placeholder</a>
    </h3>
    <span class="rank">Rank <b>99</b></span>
    <p class="info tip">no year here</p>
  </li>
</ul>`;

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'bangumi-top250');
    assert.equal(source.category, 'movie');
    assert.equal(source.subCategory, 'anime');
    assert.equal(source.kind, 'yearly');
    assert.equal(source.priority, 7);
    assert.equal(source.externalIdKind, 'pre-resolved');
});

test('parseList extracts rank, title, year, bangumi id; skips entries missing year', () => {
    const items = parseList(FIXTURE_HTML);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
        externalId: 'bangumi-253',
        rank: 4,
        title: '星际牛仔',
        year: '1998',
        bangumiId: '253',
    });
    assert.equal(items[1].externalId, 'bangumi-4');
    assert.equal(items[1].year, '2004');
});

test('scrape() reads snapshot from disk (no network)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bangumi-snap-'));
    try {
        const snapshotPath = join(dir, 'snap.json');
        await writeFile(
            snapshotPath,
            JSON.stringify({
                generatedAt: '2026-04-19T00:00:00Z',
                items: [
                    {
                        externalId: 'bangumi-253',
                        rank: 4,
                        title: '星际牛仔',
                        year: '1998',
                        bangumiId: '253',
                        doubanId: '1421027',
                    },
                ],
            }),
        );
        const http = { fetch: () => { throw new Error('no network'); } };
        const items = await source.scrape(http, { snapshotPath });
        assert.equal(items.length, 1);
        assert.equal(items[0].doubanId, '1421027');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('scrape() throws helpful message when snapshot missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bangumi-nosnap-'));
    try {
        const snapshotPath = join(dir, 'missing.json');
        const http = { fetch: () => { throw new Error('unused'); } };
        await assert.rejects(
            () => source.scrape(http, { snapshotPath }),
            /not found.*fetch:bangumi-top250-snapshot/,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('matchItem returns pre-resolved doubanId from snapshot item directly', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ids = await source.matchItem(
        {
            externalId: 'bangumi-253',
            rank: 4,
            title: '星际牛仔',
            year: '1998',
            bangumiId: '253',
            doubanId: '1421027',
        },
        http,
        {},
    );
    assert.deepEqual(ids, ['1421027']);
});

test('matchItem falls back to ctx.prevResolved when snapshot lacks doubanId', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ctx = {
        prevResolved: new Map([
            ['bangumi-top250', new Map([['bangumi-253', ['1421027']]])],
        ]),
    };
    const ids = await source.matchItem(
        {
            externalId: 'bangumi-253',
            rank: 4,
            title: '星际牛仔',
            year: '1998',
            bangumiId: '253',
            // no doubanId on this entry
        },
        http,
        ctx,
    );
    assert.deepEqual(ids, ['1421027']);
});

test('matchItem returns [] when neither snapshot nor prev cache resolves', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ids = await source.matchItem(
        {
            externalId: 'bangumi-999',
            rank: 99,
            title: 'Placeholder',
            year: '2024',
            bangumiId: '999',
        },
        http,
        {},
    );
    assert.deepEqual(ids, []);
});
