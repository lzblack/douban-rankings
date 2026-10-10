import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const WORKFLOW_DIR = new URL('../.github/workflows/', import.meta.url);

async function loadSchedules() {
    const files = (await readdir(WORKFLOW_DIR)).filter((f) => f.endsWith('.yml'));
    const out = [];
    for (const file of files) {
        const doc = parseYaml(await readFile(new URL(file, WORKFLOW_DIR), 'utf8'));
        for (const entry of doc?.on?.schedule ?? []) {
            out.push({ file: join('.github/workflows', file), cron: entry.cron });
        }
    }
    return out;
}

// Cron ORs day-of-month and day-of-week when both are restricted, so
// '0 3 1-7 * 0' fires on days 1-7 AND every Sunday — not "first Sunday".
test('no workflow cron restricts both day-of-month and day-of-week', async () => {
    const schedules = await loadSchedules();
    assert.ok(schedules.length > 0, 'expected at least one scheduled workflow');
    for (const { file, cron } of schedules) {
        const fields = cron.trim().split(/\s+/);
        assert.equal(fields.length, 5, `${file}: malformed cron '${cron}'`);
        const [, , dom, , dow] = fields;
        assert.ok(
            dom === '*' || dow === '*',
            `${file}: cron '${cron}' restricts both day-of-month and day-of-week (OR semantics)`,
        );
    }
});
