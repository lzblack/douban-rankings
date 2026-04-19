#!/usr/bin/env node
/**
 * Maintainer utility: build `config/bfi-ss-snapshot.json` for the BFI
 * Sight & Sound 2022 Critics' Poll Top 100.
 *
 * Pipeline:
 *   1. Fetch Letterboxd's curated bfi list for 100 (rank, slug) pairs
 *   2. For each slug, fetch /film/<slug>/ and extract (tt, title, year)
 *   3. Write the merged array to config/bfi-ss-snapshot.json
 *
 * Run from a residential IP (Letterboxd is more lax than Criterion but
 * we still go through system curl to avoid any TLS fingerprint issues
 * with Node's undici):
 *
 *   pnpm run fetch:bfi-ss-snapshot
 *
 * Cadence: the BFI poll itself runs every 10 years; a single snapshot
 * lasts us until the next edition. Refresh only if a contributor
 * discovers an entry has been incorrectly scraped.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const LIST_URL =
    'https://letterboxd.com/bfi/list/sight-and-sounds-greatest-films-of-all-time/';
const FILM_BASE = 'https://letterboxd.com';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'bfi-ss-snapshot.json');

const PER_FILM_DELAY_MS = 1500; // polite cadence

async function fetchViaCurl(url) {
    const { stdout } = await execFileP(
        'curl',
        [
            '-sSL',
            '--compressed',
            '-A',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            '-H',
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            '-H',
            'Accept-Language: en-US,en;q=0.9',
            '-w',
            '\\nHTTP_STATUS:%{http_code}',
            url,
        ],
        {
            maxBuffer: 32 * 1024 * 1024,
            encoding: 'utf-8',
        },
    );
    const match = stdout.match(/\nHTTP_STATUS:(\d+)$/);
    if (!match) throw new Error(`curl missing HTTP_STATUS for ${url}`);
    const status = Number(match[1]);
    const body = stdout.slice(0, stdout.length - match[0].length);
    return { status, body };
}

function parseListSlugs(html) {
    // Each film appears in order as a <li> with data-film-id and
    // data-target-link attributes on a nested div. We only need the
    // target links; their order in the HTML is rank order.
    const slugs = [];
    const re = /data-target-link="(\/film\/[^"]+\/)"/g;
    let m;
    while ((m = re.exec(html)) !== null) slugs.push(m[1]);
    // De-dupe while preserving first-seen order
    const seen = new Set();
    const unique = [];
    for (const s of slugs) {
        if (seen.has(s)) continue;
        seen.add(s);
        unique.push(s);
    }
    return unique;
}

function parseFilmPage(html) {
    const ttMatch = html.match(/imdb\.com\/title\/(tt\d+)/);
    const ogMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    // og:title is "Title (YYYY)"
    let title = '';
    let year = '';
    if (ogMatch) {
        const full = ogMatch[1];
        const yearMatch = full.match(/\((\d{4})\)\s*$/);
        if (yearMatch) {
            year = yearMatch[1];
            title = full.slice(0, yearMatch.index).trim();
        } else {
            title = full.trim();
        }
    }
    return { tt: ttMatch ? ttMatch[1] : '', title, year };
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    console.log(`Fetching list: ${LIST_URL}`);
    const listRes = await fetchViaCurl(LIST_URL);
    if (listRes.status !== 200) {
        console.error(`list HTTP ${listRes.status}`);
        process.exit(1);
    }
    const slugs = parseListSlugs(listRes.body);
    console.log(`Parsed ${slugs.length} film slugs`);
    if (slugs.length === 0) {
        console.error('zero slugs — page structure may have changed');
        process.exit(1);
    }

    const items = [];
    for (let i = 0; i < slugs.length; i++) {
        const slug = slugs[i];
        const rank = i + 1;
        process.stdout.write(`[${rank}/${slugs.length}] ${slug} ... `);
        const filmRes = await fetchViaCurl(FILM_BASE + slug);
        if (filmRes.status !== 200) {
            console.log(`HTTP ${filmRes.status}, skipping`);
            continue;
        }
        const info = parseFilmPage(filmRes.body);
        if (!info.tt) {
            console.log(`no IMDb tt, skipping`);
            continue;
        }
        console.log(`${info.tt}  ${info.title} (${info.year})`);
        items.push({
            rank,
            tt: info.tt,
            title: info.title,
            year: info.year,
            slug: slug.replace(/^\/film\//, '').replace(/\/$/, ''),
        });
        if (i + 1 < slugs.length) await sleep(PER_FILM_DELAY_MS);
    }

    if (items.length === 0) {
        console.error('no items successfully enriched');
        process.exit(1);
    }
    const payload = {
        generatedAt: new Date().toISOString(),
        source: LIST_URL,
        count: items.length,
        items,
    };
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify(payload, null, 2) + '\n',
        'utf-8',
    );
    console.log(
        `\nWrote ${items.length} entries to ${SNAPSHOT_PATH}\n` +
            `Next: git add config/bfi-ss-snapshot.json && git commit && git push`,
    );
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
