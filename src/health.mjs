import { readFile } from 'node:fs/promises';

/**
 * @typedef {Object} SourceRunOutcome
 * @property {string} id
 * @property {'ok' | 'failed' | 'skipped'} status
 * @property {number} itemCount
 * @property {string | null} [message]
 * @property {Date} [runAt]
 * @property {number} [maxAgeDays]  snapshot sources: lastSuccessAt older
 *   than this marks the entry stale (fixed one-off lists leave it unset)
 *
 * @typedef {Object} HealthEntry
 * @property {string} id
 * @property {'ok' | 'failed' | 'skipped'} status
 * @property {string | null} lastSuccessAt
 * @property {string | null} lastFailureAt
 * @property {number} consecutiveFailures
 * @property {number} itemCount
 * @property {number} itemCountDelta
 * @property {string | null} message
 * @property {boolean} stale  snapshot not refreshed within maxAgeDays
 *
 * @typedef {Object} HealthReport
 * @property {string} generatedAt
 * @property {'ok' | 'degraded' | 'failed'} overall
 * @property {HealthEntry[]} sources
 */

/**
 * Merge this run's outcomes with the previous health.json to produce
 * the next report. Consecutive-failure counters and last-success/last-failure
 * timestamps carry over from prev.
 *
 * @param {Partial<HealthReport>} prevHealth
 * @param {SourceRunOutcome[]} outcomes
 * @param {{ now?: Date }} [options]
 * @returns {HealthReport}
 */
export function buildHealthReport(
    prevHealth,
    outcomes,
    { now = new Date() } = {},
) {
    const prevById = new Map();
    for (const s of prevHealth?.sources ?? []) prevById.set(s.id, s);

    const sources = outcomes.map(outcome => {
        const entry = buildEntry(prevById.get(outcome.id), outcome, now);
        return { ...entry, stale: isStale(entry, outcome.maxAgeDays, now) };
    });

    return {
        generatedAt: now.toISOString(),
        overall: computeOverall(sources),
        sources,
    };
}

/**
 * @param {HealthEntry | undefined} prev
 * @param {SourceRunOutcome} outcome
 * @param {Date} now
 * @returns {Omit<HealthEntry, 'stale'>}
 */
function buildEntry(prev, outcome, now) {
    const prevCount = prev?.itemCount ?? 0;
    const runAtIso = (outcome.runAt ?? now).toISOString();
    const common = {
        id: outcome.id,
        itemCount: outcome.itemCount,
        itemCountDelta: outcome.itemCount - prevCount,
        message: outcome.message ?? null,
    };
    if (outcome.status === 'ok') {
        return {
            ...common,
            status: 'ok',
            lastSuccessAt: runAtIso,
            lastFailureAt: prev?.lastFailureAt ?? null,
            consecutiveFailures: 0,
        };
    }
    if (outcome.status === 'skipped') {
        // Snapshot-dependent source ran without its snapshot on disk
        // (expected in CI where config/*-snapshot.json is gitignored).
        // Carry prev counters forward unchanged — we have no new
        // information about whether the source is actually healthy.
        return {
            ...common,
            status: 'skipped',
            // Preserve prev itemCount so the delta doesn't look like a
            // regression when we have nothing to compare against.
            itemCount: prev?.itemCount ?? 0,
            itemCountDelta: 0,
            lastSuccessAt: prev?.lastSuccessAt ?? null,
            lastFailureAt: prev?.lastFailureAt ?? null,
            consecutiveFailures: prev?.consecutiveFailures ?? 0,
        };
    }
    return {
        ...common,
        status: 'failed',
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        lastFailureAt: runAtIso,
        consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
    };
}

/**
 * A snapshot source is stale when it hasn't succeeded within maxAgeDays.
 * Skipped runs carry lastSuccessAt forward, so this is what surfaces a
 * snapshot the maintainer has stopped refreshing.
 *
 * @param {{ lastSuccessAt: string | null }} entry
 * @param {number | undefined} maxAgeDays
 * @param {Date} now
 */
function isStale(entry, maxAgeDays, now) {
    if (maxAgeDays == null) return false;
    if (!entry.lastSuccessAt) return true;
    const ageMs = now.getTime() - Date.parse(entry.lastSuccessAt);
    return ageMs > maxAgeDays * 24 * 60 * 60 * 1000;
}

function computeOverall(sources) {
    if (sources.length === 0) return 'ok';
    // Skipped sources (e.g. snapshot-gitignored source running in CI) carry
    // no new run information, so ok/failed is judged among sources that
    // actually produced an outcome. A stale snapshot still degrades overall.
    const active = sources.filter(s => s.status !== 'skipped');
    if (active.length > 0 && active.every(s => s.status === 'failed')) {
        return 'failed';
    }
    if (sources.some(s => s.stale)) return 'degraded';
    if (active.every(s => s.status === 'ok')) return 'ok';
    return 'degraded';
}

/**
 * Read an existing health.json; return {} if it doesn't exist yet (first run).
 * @param {string} path
 */
export async function readPrevHealth(path) {
    try {
        return JSON.parse(await readFile(path, 'utf-8'));
    } catch (err) {
        if (err.code === 'ENOENT') return {};
        throw err;
    }
}
