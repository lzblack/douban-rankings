#!/usr/bin/env node
/**
 * Maintainer utility: fetch the Criterion Collection browse/list page
 * and produce `config/criterion-snapshot.json`.
 *
 * Run this from a residential IP (home / office). criterion.com
 * returns HTTP 403 for GitHub Actions runners and other cloud
 * providers, so the pipeline can't fetch it directly — instead it
 * reads the committed snapshot this script produces.
 *
 * Usage:
 *   pnpm run fetch:criterion-snapshot
 *
 * Cadence: quarterly is plenty (Criterion adds ~5-10 spines/month).
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseList, CRITERION_LIST_URL } from '../src/sources/criterion.mjs';

const execFileP = promisify(execFile);

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'criterion-snapshot.json');

// Criterion's edge filter rejects requests whose TLS fingerprint isn't a
// real browser's — Node's undici fetch has a distinct JA3 and gets 403
// even on residential IPs. Shelling out to the system curl (same binary
// that returns 200 in a terminal) sidesteps fingerprinting entirely.
async function fetchViaCurl(url) {
    const { stdout } = await execFileP(
        'curl',
        [
            '-sSL',
            '--compressed',
            '-A',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            '-H', 'Accept-Language: en-US,en;q=0.9',
            '-w', '\\nHTTP_STATUS:%{http_code}',
            url,
        ],
        {
            maxBuffer: 64 * 1024 * 1024, // 64MB — Criterion page is ~1.5MB
            encoding: 'utf-8',
        },
    );
    const match = stdout.match(/\nHTTP_STATUS:(\d+)$/);
    if (!match) {
        throw new Error('curl output missing HTTP_STATUS marker');
    }
    const status = Number(match[1]);
    const body = stdout.slice(0, stdout.length - match[0].length);
    return { status, body };
}

async function main() {
    console.log(`Fetching ${CRITERION_LIST_URL} (via system curl)`);
    const { status, body } = await fetchViaCurl(CRITERION_LIST_URL);
    if (status !== 200) {
        console.error(`HTTP ${status}`);
        console.error(
            'If 403: you may be on a VPN or cloud IP. Criterion blocks those.',
        );
        console.error(
            'If curl is missing: install curl and retry (Windows 10+ ships curl by default).',
        );
        process.exit(1);
    }
    const items = parseList(body);
    if (items.length === 0) {
        console.error(
            'Parsed zero entries — the page may have changed structure. Inspect the HTML manually.',
        );
        process.exit(1);
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        source: CRITERION_LIST_URL,
        count: items.length,
        items,
    };
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify(payload, null, 2) + '\n',
        'utf-8',
    );
    console.log(`Wrote ${items.length} entries to ${SNAPSHOT_PATH}`);
    console.log('Next: git add config/criterion-snapshot.json && git commit && git push');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
