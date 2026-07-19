import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    buildCategoryPayload,
    buildManifest,
    writeJsonAtomic,
    assertNoSecrets,
} from '../src/writer.mjs';

const fakeSource = {
    id: 'imdb-top250',
    category: 'movie',
    subCategory: 'movie',
    kind: 'permanent',
    priority: 1,
    meta: {
        title: 'IMDb Top 250',
        titleZh: 'IMDb 250 佳片',
        url: 'https://www.imdb.com/chart/top',
    },
};

const NOW = new Date('2026-04-18T04:00:00Z');

test('buildCategoryPayload shapes source metadata and aggregates items', () => {
    const sourceResults = [
        {
            sourceDef: fakeSource,
            itemCount: 2,
            updatedAt: new Date('2026-04-18T03:30:00Z'),
            items: [
                { doubanId: '1292052', rank: 1, externalId: 'tt0111161' },
                { doubanId: '1291841', rank: 2, externalId: 'tt0068646' },
            ],
        },
    ];
    const payload = buildCategoryPayload('movie', sourceResults, { now: NOW });

    assert.equal(payload.schemaVersion, 1);
    assert.equal(payload.generatedAt, '2026-04-18T04:00:00.000Z');
    assert.deepEqual(payload.categories.movie.sources['imdb-top250'], {
        title: 'IMDb Top 250',
        titleZh: 'IMDb 250 佳片',
        url: 'https://www.imdb.com/chart/top',
        kind: 'permanent',
        subCategory: 'movie',
        priority: 1,
        updatedAt: '2026-04-18T03:30:00.000Z',
        itemCount: 2,
    });
    assert.deepEqual(payload.categories.movie.items['1292052'], [
        { source: 'imdb-top250', rank: 1, externalId: 'tt0111161' },
    ]);
});

test('buildCategoryPayload merges same doubanId across sources, preserving spineNumber', () => {
    const criterion = {
        ...fakeSource,
        id: 'criterion',
        priority: 2,
        meta: { ...fakeSource.meta, title: 'Criterion Collection' },
    };
    const sourceResults = [
        {
            sourceDef: fakeSource,
            itemCount: 1,
            updatedAt: NOW,
            items: [{ doubanId: '1292052', rank: 1, externalId: 'tt0111161' }],
        },
        {
            sourceDef: criterion,
            itemCount: 1,
            updatedAt: NOW,
            items: [
                {
                    doubanId: '1292052',
                    rank: null,
                    externalId: 'tt0111161',
                    spineNumber: '1056',
                },
            ],
        },
    ];
    const payload = buildCategoryPayload('movie', sourceResults, { now: NOW });
    const entries = payload.categories.movie.items['1292052'];
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
        source: 'imdb-top250',
        rank: 1,
        externalId: 'tt0111161',
    });
    assert.deepEqual(entries[1], {
        source: 'criterion',
        rank: null,
        externalId: 'tt0111161',
        spineNumber: '1056',
    });
});

test('buildCategoryPayload carries prevRatings forward only for surviving doubanIds', () => {
    const sourceResults = [
        {
            sourceDef: fakeSource,
            itemCount: 1,
            updatedAt: NOW,
            items: [{ doubanId: '1292052', rank: 1, externalId: 'tt0111161' }],
        },
    ];
    const prevRatings = {
        1292052: { imdb: 93, at: '2026-07-19T00:00:00.000Z' }, // survives
        9999999: { imdb: 50, at: '2026-07-19T00:00:00.000Z' }, // dropped (not in items)
    };
    const payload = buildCategoryPayload('movie', sourceResults, { now: NOW, prevRatings });
    assert.deepEqual(payload.categories.movie.ratings, {
        1292052: { imdb: 93, at: '2026-07-19T00:00:00.000Z' },
    });
});

test('buildCategoryPayload omits ratings without prevRatings or when none survive', () => {
    const sourceResults = [
        {
            sourceDef: fakeSource,
            itemCount: 1,
            updatedAt: NOW,
            items: [{ doubanId: '1292052', rank: 1, externalId: 'tt0111161' }],
        },
    ];
    // no prevRatings → no ratings key at all
    const a = buildCategoryPayload('movie', sourceResults, { now: NOW });
    assert.equal('ratings' in a.categories.movie, false);
    // prevRatings present but for a doubanId not in items → still omitted
    const b = buildCategoryPayload('movie', sourceResults, {
        now: NOW,
        prevRatings: { 9999999: { imdb: 50, at: '2026-07-19T00:00:00.000Z' } },
    });
    assert.equal('ratings' in b.categories.movie, false);
});

test('buildManifest lists categories and URLs with configurable baseUrl', () => {
    const manifest = buildManifest(['movie'], {
        now: NOW,
        baseUrl: 'https://rank.douban.zhili.dev',
    });
    assert.deepEqual(manifest, {
        schemaVersion: 1,
        generatedAt: '2026-04-18T04:00:00.000Z',
        categories: ['movie'],
        urls: { movie: 'https://rank.douban.zhili.dev/movie.json' },
    });
});

test('writeJsonAtomic writes pretty JSON and creates parent dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'writer-test-'));
    try {
        const path = join(dir, 'nested', 'out.json');
        await writeJsonAtomic(path, { a: 1, b: [2, 3] });
        const content = await readFile(path, 'utf-8');
        assert.equal(
            content,
            '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}\n',
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('assertNoSecrets throws when a secret appears, ignores empty/absent ones', () => {
    assert.throws(
        () => assertNoSecrets('{"key":"SECRET123"}', ['SECRET123']),
        /leak guard/,
    );
    // never echo the secret in the message
    try {
        assertNoSecrets('SECRET123', ['SECRET123']);
        assert.fail('should have thrown');
    } catch (e) {
        assert.equal(e.message.includes('SECRET123'), false);
    }
    assert.doesNotThrow(() => assertNoSecrets('{"a":1}', ['SECRET123']));
    assert.doesNotThrow(() => assertNoSecrets('{"a":1}', ['', undefined]));
});

test('writeJsonAtomic aborts the write when output would leak a secret', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'writer-test-'));
    try {
        const path = join(dir, 'leak.json');
        await assert.rejects(
            writeJsonAtomic(path, { token: 'S:kkey123' }, { secrets: ['S:kkey123'] }),
            /leak guard/,
        );
        // nothing published, not even the tmp file
        await assert.rejects(readFile(path, 'utf-8'), /ENOENT/);
        await assert.rejects(readFile(`${path}.tmp`, 'utf-8'), /ENOENT/);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
