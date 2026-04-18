import { readFile } from 'node:fs/promises';

/**
 * @typedef {Object} SourceRunOutcome
 * @property {string} id
 * @property {'ok' | 'failed'} status
 * @property {number} itemCount
 * @property {string | null} [message]
 * @property {Date} [runAt]
 *
 * @typedef {Object} HealthEntry
 * @property {string} id
 * @property {'ok' | 'failed'} status
 * @property {string | null} lastSuccessAt
 * @property {string | null} lastFailureAt
 * @property {number} consecutiveFailures
 * @property {number} itemCount
 * @property {number} itemCountDelta
 * @property {string | null} message
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
        const prev = prevById.get(outcome.id);
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
        return {
            ...common,
            status: 'failed',
            lastSuccessAt: prev?.lastSuccessAt ?? null,
            lastFailureAt: runAtIso,
            consecutiveFailures: (prev?.consecutiveFailures ?? 0) + 1,
        };
    });

    return {
        generatedAt: now.toISOString(),
        overall: computeOverall(sources),
        sources,
    };
}

function computeOverall(sources) {
    if (sources.length === 0) return 'ok';
    if (sources.every(s => s.status === 'ok')) return 'ok';
    if (sources.every(s => s.status === 'failed')) return 'failed';
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
