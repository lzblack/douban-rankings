// Standalone enrich step: augment data/<category>.json with cross-platform
// ratings from MDBList, keyed by Douban subject id. Run locally after the
// pipeline (`pnpm run update`) has produced the full movie.json:
//
//   pnpm run enrich
//
// Key handling (CLAUDE.md §密钥): read from process.env.MDBLIST_API_KEY, which
// the pnpm script loads from a gitignored .env via `--env-file-if-exists`. If
// the key is absent the step is a no-op, so contributors/CI without a key still
// succeed. writeJsonAtomic's secret guard ensures the key can never land in the
// published JSON.
//
// Quota: MDBList's free tier is ~1000 req/day. The first cold fill of ~1830
// tt-backed titles therefore spans two runs at the default 900/run cap; steady
// state only refetches missing or >TTL-old titles (default 90 days).

import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createHttpClient } from '../util/http.mjs';
import { writeJsonAtomic } from '../writer.mjs';
import { enrichPayload } from './mdblist.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_DIR = join(ROOT, 'data');
const CATEGORY = 'movie';

const DAY_MS = 24 * 60 * 60 * 1000;

async function main() {
    const key = process.env.MDBLIST_API_KEY;
    if (!key) {
        console.log('[enrich] MDBLIST_API_KEY not set — skipping enrichment (no-op).');
        return;
    }

    const maxRequests = Number(process.env.MDBLIST_MAX_REQUESTS ?? 900);
    const ttlDays = Number(process.env.MDBLIST_TTL_DAYS ?? 90);
    const negativeTtlDays = Number(process.env.MDBLIST_NEGATIVE_TTL_DAYS ?? 30);
    if (!(maxRequests > 0) || !(ttlDays > 0) || !(negativeTtlDays > 0)) {
        console.error(
            '[enrich] MDBLIST_MAX_REQUESTS / MDBLIST_TTL_DAYS / MDBLIST_NEGATIVE_TTL_DAYS must be positive.',
        );
        process.exit(1);
    }

    const path = join(DATA_DIR, `${CATEGORY}.json`);
    const movieJson = JSON.parse(await readFile(path, 'utf-8'));
    if (movieJson?.schemaVersion !== 1) {
        console.error(`[enrich] ${CATEGORY}.json schemaVersion !== 1 — aborting.`);
        process.exit(1);
    }

    // Dedicated client so MDBList's rate limit is isolated from the scrape
    // pipeline's per-host limits. ~1.2s/req is polite and well under the
    // daily-quota constraint (which is the real binding limit, not rate).
    const http = createHttpClient({
        rateLimits: { 'api.mdblist.com': { minDelay: 1200 } },
        jitter: 0.2,
    });

    const now = new Date();
    const { payload, summary } = await enrichPayload(movieJson, {
        http,
        key,
        ttlMs: ttlDays * DAY_MS,
        negativeTtlMs: negativeTtlDays * DAY_MS,
        maxRequests,
        now,
        category: CATEGORY,
        log: msg => console.log(`[enrich] ${msg}`),
    });

    await writeJsonAtomic(path, payload, { secrets: [key] });

    console.log('[enrich] done:', JSON.stringify(summary));
    if (summary.errored > 0) {
        console.log(
            `[enrich] ${summary.errored} titles hit a transient error (quota/5xx/network) — ` +
                'left stale, not negative-cached; they retry on the next run.',
        );
    }
    if (summary.skippedByCap > 0) {
        console.log(
            `[enrich] ${summary.skippedByCap} titles left for next run — hit the ` +
                `${maxRequests}-request/run budget. Re-run tomorrow to continue the ` +
                'cold fill (stays under MDBList’s daily quota).',
        );
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    main().catch(err => {
        console.error('[enrich] failed:', err);
        process.exit(1);
    });
}
