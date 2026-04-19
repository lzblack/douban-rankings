import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import source from '../../src/sources/letterboxd-top250.mjs';

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'letterboxd-top250');
    assert.equal(source.category, 'movie');
    assert.equal(source.kind, 'permanent');
    assert.equal(source.priority, 5);
    assert.equal(source.externalIdKind, 'imdb');
    assert.ok(source.meta.title);
});

test('scrape() reads snapshot and maps tt → externalId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lb-snap-'));
    try {
        const snapshotPath = join(dir, 'snap.json');
        await writeFile(
            snapshotPath,
            JSON.stringify({
                generatedAt: '2026-04-19T00:00:00Z',
                items: [
                    { rank: 1, tt: 'tt0816692', title: 'Interstellar', year: '2014' },
                    { rank: 2, tt: 'tt0097165', title: 'Dead Poets Society', year: '1989' },
                ],
            }),
        );
        const http = { fetch: () => { throw new Error('no network'); } };
        const items = await source.scrape(http, { snapshotPath });
        assert.equal(items.length, 2);
        assert.equal(items[0].externalId, 'tt0816692');
        assert.equal(items[0].rank, 1);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('scrape() throws helpful message when snapshot missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lb-nosnap-'));
    try {
        const snapshotPath = join(dir, 'missing.json');
        const http = { fetch: () => { throw new Error('unused'); } };
        await assert.rejects(
            () => source.scrape(http, { snapshotPath }),
            /not found.*fetch:letterboxd-top250-snapshot/,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('matchItem returns ctx.prevResolved cache when present', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ctx = {
        prevResolved: new Map([
            ['letterboxd-top250', new Map([['tt0816692', ['1889243']]])],
        ]),
    };
    const ids = await source.matchItem(
        { externalId: 'tt0816692', rank: 1, title: 'Interstellar', year: '2014' },
        http,
        ctx,
    );
    assert.deepEqual(ids, ['1889243']);
});
