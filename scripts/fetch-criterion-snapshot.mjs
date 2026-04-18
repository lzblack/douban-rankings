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
import { createHttpClient } from '../src/util/http.mjs';
import { parseList, CRITERION_LIST_URL } from '../src/sources/criterion.mjs';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'criterion-snapshot.json');

async function main() {
    const http = createHttpClient({
        defaultMinDelay: 0, // single request; no throttling needed
    });
    console.log(`Fetching ${CRITERION_LIST_URL}`);
    const res = await http.fetch(CRITERION_LIST_URL, {
        headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Upgrade-Insecure-Requests': '1',
        },
    });
    if (!res.ok) {
        console.error(`HTTP ${res.status}`);
        console.error(
            'If you see 403, verify you\'re on a residential IP (VPN/cloud addresses are blocked by Criterion).',
        );
        process.exit(1);
    }
    const html = await res.text();
    const items = parseList(html);
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
