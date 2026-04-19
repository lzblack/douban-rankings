import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import source from '../../src/sources/tspdt-1000.mjs';

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'tspdt-1000');
    assert.equal(source.category, 'movie');
    assert.equal(source.kind, 'yearly');
    assert.equal(source.priority, 6);
    assert.equal(source.externalIdKind, 'imdb');
    assert.ok(source.meta.title);
});

test('scrape() reads snapshot and maps tt → externalId', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tspdt-snap-'));
    try {
        const snapshotPath = join(dir, 'snap.json');
        await writeFile(
            snapshotPath,
            JSON.stringify({
                generatedAt: '2026-04-19T00:00:00Z',
                items: [
                    { rank: 1, tt: 'tt0033467', title: 'Citizen Kane', year: '1941' },
                    { rank: 2, tt: 'tt0052357', title: 'Vertigo', year: '1958' },
                ],
            }),
        );
        const http = { fetch: () => { throw new Error('no network'); } };
        const items = await source.scrape(http, { snapshotPath });
        assert.equal(items.length, 2);
        assert.equal(items[0].externalId, 'tt0033467');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('scrape() throws helpful message when snapshot missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tspdt-nosnap-'));
    try {
        const snapshotPath = join(dir, 'missing.json');
        const http = { fetch: () => { throw new Error('unused'); } };
        await assert.rejects(
            () => source.scrape(http, { snapshotPath }),
            /not found.*fetch:tspdt-1000-snapshot/,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('matchItem returns ctx.prevResolved cache when present', async () => {
    const http = { fetch: () => { throw new Error('no network'); } };
    const ctx = {
        prevResolved: new Map([['tspdt-1000', new Map([['tt0033467', ['1292288']]])]]),
    };
    const ids = await source.matchItem(
        { externalId: 'tt0033467', rank: 1, title: 'Citizen Kane', year: '1941' },
        http,
        ctx,
    );
    assert.deepEqual(ids, ['1292288']);
});
