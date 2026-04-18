import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildHealthReport, readPrevHealth } from '../src/health.mjs';

const NOW = new Date('2026-04-18T04:00:00Z');

test('overall=ok when every source is ok', () => {
    const report = buildHealthReport(
        {},
        [{ id: 'a', status: 'ok', itemCount: 250 }],
        { now: NOW },
    );
    assert.equal(report.overall, 'ok');
    assert.equal(report.sources[0].lastSuccessAt, '2026-04-18T04:00:00.000Z');
    assert.equal(report.sources[0].lastFailureAt, null);
    assert.equal(report.sources[0].consecutiveFailures, 0);
});

test('overall=failed when every source failed', () => {
    const report = buildHealthReport(
        {},
        [{ id: 'a', status: 'failed', itemCount: 0, message: 'timeout' }],
        { now: NOW },
    );
    assert.equal(report.overall, 'failed');
    assert.equal(report.sources[0].lastFailureAt, '2026-04-18T04:00:00.000Z');
    assert.equal(report.sources[0].message, 'timeout');
});

test('overall=degraded when mix of ok and failed', () => {
    const report = buildHealthReport(
        {},
        [
            { id: 'a', status: 'ok', itemCount: 1 },
            { id: 'b', status: 'failed', itemCount: 0 },
        ],
        { now: NOW },
    );
    assert.equal(report.overall, 'degraded');
});

test('consecutiveFailures increments across prev failures', () => {
    const prev = {
        sources: [
            {
                id: 'a',
                status: 'failed',
                consecutiveFailures: 2,
                lastSuccessAt: '2026-04-10T00:00:00.000Z',
                lastFailureAt: '2026-04-17T00:00:00.000Z',
                itemCount: 5,
            },
        ],
    };
    const report = buildHealthReport(
        prev,
        [{ id: 'a', status: 'failed', itemCount: 5 }],
        { now: NOW },
    );
    assert.equal(report.sources[0].consecutiveFailures, 3);
    assert.equal(report.sources[0].lastSuccessAt, '2026-04-10T00:00:00.000Z');
    assert.equal(report.sources[0].lastFailureAt, '2026-04-18T04:00:00.000Z');
});

test('ok run resets consecutiveFailures and preserves lastFailureAt', () => {
    const prev = {
        sources: [
            {
                id: 'a',
                status: 'failed',
                consecutiveFailures: 5,
                lastSuccessAt: null,
                lastFailureAt: '2026-04-17T00:00:00.000Z',
                itemCount: 0,
            },
        ],
    };
    const report = buildHealthReport(
        prev,
        [{ id: 'a', status: 'ok', itemCount: 250 }],
        { now: NOW },
    );
    assert.equal(report.sources[0].consecutiveFailures, 0);
    assert.equal(report.sources[0].lastFailureAt, '2026-04-17T00:00:00.000Z');
});

test('itemCountDelta computed against previous count', () => {
    const prev = {
        sources: [
            {
                id: 'a',
                status: 'ok',
                itemCount: 248,
                consecutiveFailures: 0,
                lastSuccessAt: '2026-04-17T00:00:00.000Z',
                lastFailureAt: null,
            },
        ],
    };
    const report = buildHealthReport(
        prev,
        [{ id: 'a', status: 'ok', itemCount: 250 }],
        { now: NOW },
    );
    assert.equal(report.sources[0].itemCountDelta, 2);
});

test('readPrevHealth returns {} when file missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'health-test-'));
    try {
        const result = await readPrevHealth(join(dir, 'nope.json'));
        assert.deepEqual(result, {});
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('readPrevHealth parses existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'health-test-'));
    try {
        const path = join(dir, 'health.json');
        await writeFile(path, JSON.stringify({ overall: 'ok', sources: [] }));
        const result = await readPrevHealth(path);
        assert.equal(result.overall, 'ok');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
