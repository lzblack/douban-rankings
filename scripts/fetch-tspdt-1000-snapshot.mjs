#!/usr/bin/env node
/**
 * Maintainer utility: build `config/tspdt-1000-snapshot.json`.
 *
 * Scrapes the Letterboxd mirror of TSPDT 1000 (maintained by user
 * `thisisdrew`), 10 pages × 100 films, then fetches each film page
 * for IMDb tt + title + year.
 *
 * Long one-time run (~30 min; 1000 pages at 1.5s/req), but annually
 * after that.
 *
 *   pnpm run fetch:tspdt-1000-snapshot
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const LIST_BASE =
    'https://letterboxd.com/thisisdrew/list/they-shoot-pictures-dont-they-1000-greatest-6/';
const FILM_BASE = 'https://letterboxd.com';
const PAGES = [''];
for (let p = 2; p <= 10; p++) PAGES.push(`page/${p}/`);

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'tspdt-1000-snapshot.json');

const PER_FILM_DELAY_MS = 1500;

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
    const slugs = [];
    const re = /data-target-link="(\/film\/[^"]+\/)"/g;
    let m;
    while ((m = re.exec(html)) !== null) slugs.push(m[1]);
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
    const allSlugs = [];
    for (const suffix of PAGES) {
        const url = LIST_BASE + suffix;
        console.log(`Fetching list: ${url}`);
        const res = await fetchViaCurl(url);
        if (res.status !== 200) {
            console.error(`list page HTTP ${res.status}`);
            process.exit(1);
        }
        const slugs = parseListSlugs(res.body);
        console.log(`  ${slugs.length} films on this page`);
        allSlugs.push(...slugs);
        await sleep(1000);
    }
    const seen = new Set();
    const slugs = [];
    for (const s of allSlugs) {
        if (seen.has(s)) continue;
        seen.add(s);
        slugs.push(s);
    }
    console.log(`Total unique slugs: ${slugs.length}`);
    if (slugs.length === 0) {
        console.error('zero slugs — page structure may have changed');
        process.exit(1);
    }

    const items = [];
    const failed = [];
    for (let i = 0; i < slugs.length; i++) {
        const slug = slugs[i];
        const rank = i + 1;
        if (rank % 50 === 0 || rank <= 3 || rank >= slugs.length - 2) {
            process.stdout.write(`[${rank}/${slugs.length}] ${slug} ... `);
        }
        let filmRes;
        try {
            filmRes = await fetchViaCurl(FILM_BASE + slug);
        } catch (err) {
            failed.push(slug);
            if (rank % 50 === 0) console.log(`curl err, skipping`);
            continue;
        }
        if (filmRes.status !== 200) {
            failed.push(slug);
            if (rank % 50 === 0) console.log(`HTTP ${filmRes.status}, skipping`);
            continue;
        }
        const info = parseFilmPage(filmRes.body);
        if (!info.tt) {
            failed.push(slug);
            if (rank % 50 === 0) console.log('no tt, skipping');
            continue;
        }
        if (rank % 50 === 0 || rank <= 3 || rank >= slugs.length - 2) {
            console.log(`${info.tt}  ${info.title} (${info.year})`);
        }
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
        console.error('no items enriched');
        process.exit(1);
    }
    const payload = {
        generatedAt: new Date().toISOString(),
        source: LIST_BASE,
        count: items.length,
        items,
    };
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify(payload, null, 2) + '\n',
        'utf-8',
    );
    console.log(
        `\nWrote ${items.length} entries to ${SNAPSHOT_PATH}` +
            (failed.length ? `\n(${failed.length} slugs failed to enrich)` : '') +
            `\nNext: git add config/tspdt-1000-snapshot.json && git commit && git push`,
    );
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
