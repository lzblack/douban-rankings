#!/usr/bin/env node
/**
 * Maintainer utility: build `config/grammy-aoty-snapshot.json`.
 *
 * Pipeline:
 *   1. Scrape Wikipedia Grammy AOTY page (~65 winners across decade
 *      wikitables).
 *   2. Resolve each winning album's Douban music subject id via
 *      search.douban.com/music/subject_search @ 5.5s/req on a
 *      residential IP.
 *
 * Re-run annually after the Grammy ceremony (February).
 *
 *   pnpm run fetch:grammy-aoty-snapshot
 */

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseList, GRAMMY_AOTY_LIST_URL } from '../src/sources/grammy-aoty.mjs';

const execFileP = promisify(execFile);

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'grammy-aoty-snapshot.json');

const DOUBAN_DELAY_MS = 5500;

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
        { maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8' },
    );
    const match = stdout.match(/\nHTTP_STATUS:(\d+)$/);
    if (!match) throw new Error(`curl missing HTTP_STATUS for ${url}`);
    const status = Number(match[1]);
    const body = stdout.slice(0, stdout.length - match[0].length);
    return { status, body };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function resolveDouban(title, artist) {
    const q = `${title} ${artist}`;
    const url = `https://search.douban.com/music/subject_search?search_text=${encodeURIComponent(q)}`;
    const res = await fetchViaCurl(url);
    if (res.status !== 200) return null;
    const m = res.body.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
    if (!m) return null;
    let data;
    try {
        data = JSON.parse(m[1]);
    } catch {
        return null;
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) return null;
    // Prefer first item with a rating (filters bootleg stubs), else first
    const withRating = items.find(it => it?.rating?.value);
    const pick = withRating ?? items[0];
    return pick?.id ? String(pick.id) : null;
}

async function main() {
    const existing = new Map();
    try {
        const raw = await readFile(SNAPSHOT_PATH, 'utf-8');
        const prev = JSON.parse(raw);
        for (const it of prev?.items ?? []) {
            if (it.externalId && it.doubanId) existing.set(it.externalId, it.doubanId);
        }
        console.log(`Loaded ${existing.size} previously-resolved dbids for reuse`);
    } catch {
        // first run
    }

    console.log(`Fetching list: ${GRAMMY_AOTY_LIST_URL}`);
    const listRes = await fetchViaCurl(GRAMMY_AOTY_LIST_URL);
    if (listRes.status !== 200) {
        console.error(`list HTTP ${listRes.status}`);
        process.exit(1);
    }
    const entries = parseList(listRes.body);
    console.log(`Parsed ${entries.length} winners`);

    const items = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const reused = existing.get(e.externalId);
        if (reused) {
            console.log(`[${i + 1}/${entries.length}] ${e.title} — ${e.artist} (${e.year}) → ${reused}  (reused)`);
            items.push({ ...e, doubanId: reused });
            continue;
        }
        process.stdout.write(`[${i + 1}/${entries.length}] ${e.title} — ${e.artist} (${e.year}) → `);
        const dbid = await resolveDouban(e.title, e.artist);
        console.log(dbid ? `dbid=${dbid}` : 'unresolved');
        items.push({ ...e, ...(dbid ? { doubanId: dbid } : {}) });
        if (i + 1 < entries.length) await sleep(DOUBAN_DELAY_MS);
    }

    const resolved = items.filter(it => it.doubanId).length;
    const payload = {
        generatedAt: new Date().toISOString(),
        source: GRAMMY_AOTY_LIST_URL,
        count: items.length,
        resolvedCount: resolved,
        items,
    };
    await writeFile(
        SNAPSHOT_PATH,
        JSON.stringify(payload, null, 2) + '\n',
        'utf-8',
    );
    console.log(
        `\nWrote ${items.length} entries (${resolved} resolved) to ${SNAPSHOT_PATH}\n` +
            `Next: git add config/grammy-aoty-snapshot.json && git commit && git push`,
    );
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
