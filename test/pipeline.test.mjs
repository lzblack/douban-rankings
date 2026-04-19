import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    runSource,
    runAll,
    groupByCategory,
    loadPrevResolved,
} from '../src/pipeline.mjs';

const fakeHttp = { fetch: async () => new Response('') };

function makeSource({
    id = 's',
    category = 'movie',
    externalIdKind = 'imdb',
    scraped = [],
    shouldThrow = false,
} = {}) {
    return {
        id,
        category,
        subCategory: 'movie',
        kind: 'permanent',
        priority: 1,
        externalIdKind,
        meta: { title: id, titleZh: id, url: `https://${id}.example/` },
        async scrape() {
            if (shouldThrow) throw new Error('scrape failed');
            return scraped;
        },
    };
}

test('runSource invokes matcher keyed by externalIdKind', async () => {
    const source = makeSource({
        scraped: [
            { externalId: 'tt1', rank: 1, title: 'A' },
            { externalId: 'tt2', rank: 2, title: 'B' },
        ],
    });
    const matcher = async id => (id === 'tt1' ? '101' : '202');
    const result = await runSource(source, fakeHttp, {
        matchers: { imdb: matcher },
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.itemCount, 2);
    assert.equal(result.scrapedCount, 2);
    assert.deepEqual(result.items[0], {
        doubanId: '101',
        rank: 1,
        externalId: 'tt1',
    });
});

test('runSource drops items whose matcher returns null', async () => {
    const source = makeSource({
        scraped: [
            { externalId: 'tt1', rank: 1, title: 'A' },
            { externalId: 'tt2', rank: 2, title: 'B' },
        ],
    });
    const matcher = async id => (id === 'tt1' ? '101' : null);
    const result = await runSource(source, fakeHttp, {
        matchers: { imdb: matcher },
    });
    assert.equal(result.itemCount, 1);
    assert.equal(result.scrapedCount, 2);
    assert.equal(result.items[0].externalId, 'tt1');
});

test('runSource captures scrape errors as failed, never throws', async () => {
    const source = makeSource({ shouldThrow: true });
    const result = await runSource(source, fakeHttp, {
        matchers: { imdb: async () => '1' },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /scrape failed/);
    assert.equal(result.items.length, 0);
});

test('runSource fails when externalIdKind has no registered matcher', async () => {
    const source = makeSource({ externalIdKind: 'unknown' });
    const result = await runSource(source, fakeHttp, {
        matchers: { imdb: async () => '1' },
    });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /no matcher registered/);
});

test('runAll isolates per-source failures (one failing does not stop others)', async () => {
    const ok = makeSource({
        id: 'ok',
        scraped: [{ externalId: 'tt1', rank: 1 }],
    });
    const bad = makeSource({ id: 'bad', shouldThrow: true });
    const results = await runAll([ok, bad], fakeHttp, {
        matchers: { imdb: async () => '1' },
    });
    assert.equal(results.length, 2);
    assert.equal(results[0].status, 'ok');
    assert.equal(results[1].status, 'failed');
});

test('groupByCategory includes only ok sources and buckets them', () => {
    const grouped = groupByCategory([
        { status: 'ok', sourceDef: { category: 'movie' } },
        { status: 'failed', sourceDef: { category: 'movie' } },
        { status: 'ok', sourceDef: { category: 'book' } },
    ]);
    assert.equal(grouped.movie.length, 1);
    assert.equal(grouped.book.length, 1);
    assert.equal(grouped.failed, undefined);
});

test('runSource expands a raw item into one entry per dbid when matcher returns string[]', async () => {
    const source = makeSource({
        scraped: [{ externalId: 'tt0068646', rank: 2, title: 'The Godfather' }],
    });
    const matcher = async () => ['1291841', '34447553']; // two dbids for one tt
    const result = await runSource(source, fakeHttp, {
        matchers: { imdb: matcher },
    });
    assert.equal(result.status, 'ok');
    // itemCount is unique externalIds, not expanded entries
    assert.equal(result.itemCount, 1);
    assert.equal(result.scrapedCount, 1);
    // items array has one entry per dbid, both sharing the externalId
    assert.equal(result.items.length, 2);
    const ids = result.items.map(i => i.doubanId).sort();
    assert.deepEqual(ids, ['1291841', '34447553']);
    for (const i of result.items) {
        assert.equal(i.externalId, 'tt0068646');
        assert.equal(i.rank, 2);
    }
});

test('runSource treats empty array return as unresolved', async () => {
    const source = makeSource({
        scraped: [{ externalId: 'tt-unknown', rank: 1, title: 'Nothing' }],
    });
    const matcher = async () => []; // matcher found nothing
    const result = await runSource(source, fakeHttp, {
        matchers: { imdb: matcher },
    });
    assert.equal(result.itemCount, 0);
    assert.equal(result.items.length, 0);
});

test('runSource prefers source.matchItem over externalIdKind registry', async () => {
    const source = {
        id: 's',
        category: 'movie',
        subCategory: 'movie',
        kind: 'permanent',
        priority: 1,
        externalIdKind: 'title-year',
        meta: { title: 's', titleZh: 's', url: 'https://example/' },
        scrape: async () => [
            { externalId: '0001', rank: null, title: 'A', year: '1937' },
        ],
        matchItem: async (raw, _http, ctx) => {
            assert.equal(raw.externalId, '0001');
            assert.ok(ctx);
            return 'douban-' + raw.externalId;
        },
    };
    const result = await runSource(source, fakeHttp, {
        matchers: {},  // empty registry; matchItem should be used
        ctx: { some: 'context' },
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.itemCount, 1);
    assert.equal(result.items[0].doubanId, 'douban-0001');
});

test('runSource fails when source has neither matchItem nor registered matcher', async () => {
    const source = {
        id: 's',
        category: 'movie',
        subCategory: 'movie',
        kind: 'permanent',
        priority: 1,
        externalIdKind: 'unknown-kind',
        meta: { title: 's', titleZh: 's', url: 'https://example/' },
        scrape: async () => [],
    };
    const result = await runSource(source, fakeHttp, { matchers: {} });
    assert.equal(result.status, 'failed');
    assert.match(result.message, /no matcher registered.*and source has no matchItem/);
});

test('loadPrevResolved builds sourceId → (externalId → doubanId[]) arrays, merging multi-version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pipeline-prev-'));
    try {
        await writeFile(
            join(dir, 'manifest.json'),
            JSON.stringify({ schemaVersion: 1, categories: ['movie'] }),
        );
        await writeFile(
            join(dir, 'movie.json'),
            JSON.stringify({
                schemaVersion: 1,
                categories: {
                    movie: {
                        sources: {},
                        items: {
                            '1292052': [
                                { source: 'imdb-top250', rank: 1, externalId: 'tt0111161' },
                            ],
                            // Same tt maps to two doubanIds (original + restoration).
                            '1291841': [
                                { source: 'imdb-top250', rank: 2, externalId: 'tt0068646' },
                            ],
                            '34447553': [
                                { source: 'imdb-top250', rank: 2, externalId: 'tt0068646' },
                            ],
                            '1294808': [
                                { source: 'criterion', rank: null, externalId: '0001' },
                            ],
                        },
                    },
                },
            }),
        );
        const map = await loadPrevResolved(dir);
        assert.deepEqual(map.get('imdb-top250').get('tt0111161'), ['1292052']);
        assert.deepEqual(
            map.get('imdb-top250').get('tt0068646').sort(),
            ['1291841', '34447553'].sort(),
        );
        assert.deepEqual(map.get('criterion').get('0001'), ['1294808']);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('loadPrevResolved returns empty map when no prior files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pipeline-empty-'));
    try {
        const map = await loadPrevResolved(dir);
        assert.equal(map.size, 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
