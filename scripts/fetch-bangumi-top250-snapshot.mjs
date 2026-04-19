#!/usr/bin/env node
/**
 * Maintainer utility: build `config/bangumi-top250-snapshot.json`.
 *
 * Two-phase fetch:
 *   1. Scrape bgm.tv anime rank pages 1-11 for (rank, bangumiId,
 *      title, year) — ~1s/page, fast.
 *   2. For each anime, resolve Douban subject id via search.douban.com
 *      with 5s/req pacing. This is the slow part (~21 min for 250).
 *
 * Done locally so we burn exactly one douban-search burst (on a
 * residential IP) instead of every monthly workflow run.
 *
 *   pnpm run fetch:bangumi-top250-snapshot
 */

import { writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseList } from '../src/sources/bangumi-top250.mjs';

const execFileP = promisify(execFile);

const LIST_BASE = 'https://bgm.tv/anime/browser';
const PAGE_COUNT = 11;
const TOP_N = 250;

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SNAPSHOT_PATH = join(PROJECT_ROOT, 'config', 'bangumi-top250-snapshot.json');

const BGM_DELAY_MS = 1500;
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
            'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
            '-w',
            '\\nHTTP_STATUS:%{http_code}',
            url,
        ],
        { maxBuffer: 32 * 1024 * 1024, encoding: 'utf-8' },
    );
    const match = stdout.match(/\nHTTP_STATUS:(\d+)$/);
    if (!match) throw new Error(`curl missing HTTP_STATUS for ${url}`);
    const status = Number(match[1]);
    const body = stdout.slice(0, stdout.length - match[0].length);
    return { status, body };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function resolveDouban(title, year) {
    const url = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(title)}`;
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

    const yearNum = Number(year);
    if (Number.isNaN(yearNum)) return null;

    const itemYear = it => {
        const match = (it?.title ?? '').match(/\((\d{4})\)/);
        return match ? Number(match[1]) : null;
    };
    const exact = items.find(it => itemYear(it) === yearNum);
    if (exact?.id) return String(exact.id);
    const near = items.find(it => {
        const y = itemYear(it);
        return y != null && Math.abs(y - yearNum) <= 1;
    });
    return near?.id ? String(near.id) : null;
}

async function main() {
    // Optional: resume support — if snapshot exists, reuse doubanIds already resolved
    const existing = new Map();
    try {
        const raw = await readFile(SNAPSHOT_PATH, 'utf-8');
        const prev = JSON.parse(raw);
        for (const it of prev?.items ?? []) {
            if (it.bangumiId && it.doubanId) existing.set(it.bangumiId, it.doubanId);
        }
        console.log(`Loaded ${existing.size} previously-resolved doubanIds for reuse`);
    } catch {
        // first run, no prior file
    }

    // Phase 1: scrape bgm.tv pages
    const scraped = [];
    for (let page = 1; page <= PAGE_COUNT; page++) {
        const url = `${LIST_BASE}?sort=rank&page=${page}`;
        console.log(`[bgm] page ${page}: ${url}`);
        const res = await fetchViaCurl(url);
        if (res.status !== 200) {
            console.error(`bgm page ${page} HTTP ${res.status}`);
            process.exit(1);
        }
        scraped.push(...parseList(res.body));
        if (scraped.length >= TOP_N) break;
        await sleep(BGM_DELAY_MS);
    }
    const entries = scraped.slice(0, TOP_N);
    console.log(`Scraped ${entries.length} anime entries`);

    // Phase 2: resolve douban id for each (skip ones we already have)
    const items = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const reused = existing.get(e.bangumiId);
        if (reused) {
            console.log(`[${i + 1}/${entries.length}] ${e.title} (${e.year}) → dbid=${reused}  (reused)`);
            items.push({ ...e, doubanId: reused });
            continue;
        }
        process.stdout.write(`[${i + 1}/${entries.length}] ${e.title} (${e.year}) → `);
        const dbid = await resolveDouban(e.title, e.year);
        console.log(dbid ? `dbid=${dbid}` : 'unresolved');
        items.push({ ...e, ...(dbid ? { doubanId: dbid } : {}) });
        if (i + 1 < entries.length) await sleep(DOUBAN_DELAY_MS);
    }

    const resolved = items.filter(it => it.doubanId).length;
    const payload = {
        generatedAt: new Date().toISOString(),
        source: LIST_BASE,
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
            `Next: git add config/bangumi-top250-snapshot.json && git commit && git push`,
    );
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
