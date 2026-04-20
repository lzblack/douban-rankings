/**
 * Shared helpers for doulist-backed snapshot fetchers.
 *
 * Used by: grammy, bangumi, criterion. Each of those sources pre-resolves
 * Douban subject ids by scraping a hand-curated `douban.com/doulist/<id>`
 * page instead of burning through `search.douban.com` at 5 s/req.
 *
 * The helpers here cover just the parts that were duplicated verbatim
 * across three fetchers:
 *   - fetchViaCurl: shells out to system curl (Node fetch's TLS
 *     fingerprint is blocked by some Douban endpoints).
 *   - scrapeDoulistAll: pages through a doulist and returns
 *     [{ dbid, title, abstract, comment, year }] where `year` is the
 *     first 4-digit sequence found in the 评语 (comment) field.
 *   - normalizeForMatch: fuzzy-match normalization that collapses
 *     sequel markers (第X季 / Season X / II / Ⅱ) to a common "s<N>"
 *     token before stripping to CJK + ASCII alphanumerics.
 *
 * Source-specific bits — year extraction from a different field (e.g.
 * `年份:` in `.abstract` rather than the 评语), subject-page enrichment,
 * co-winner disambiguation — stay inline in each fetcher so this module
 * doesn't grow a laundry list of flags.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as cheerio from 'cheerio';

const execFileP = promisify(execFile);

const DEFAULT_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * @param {string} url
 * @param {{ acceptLanguage?: string, maxBufferBytes?: number }} [opts]
 * @returns {Promise<{ status: number, body: string }>}
 */
export async function fetchViaCurl(url, opts = {}) {
    const acceptLanguage = opts.acceptLanguage ?? 'en-US,en;q=0.9';
    const maxBuffer = opts.maxBufferBytes ?? 32 * 1024 * 1024;
    const { stdout } = await execFileP(
        'curl',
        [
            '-sSL',
            '--compressed',
            '-A', DEFAULT_UA,
            '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            '-H', `Accept-Language: ${acceptLanguage}`,
            '-w', '\\nHTTP_STATUS:%{http_code}',
            url,
        ],
        { maxBuffer, encoding: 'utf-8' },
    );
    const match = stdout.match(/\nHTTP_STATUS:(\d+)$/);
    if (!match) throw new Error(`curl output missing HTTP_STATUS marker for ${url}`);
    const status = Number(match[1]);
    const body = stdout.slice(0, stdout.length - match[0].length);
    return { status, body };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Page through a Douban doulist and parse each entry. Pagination
 * continues until a page returns zero items — partial pages (e.g.
 * start=1500 returning 24) still count and the loop proceeds, because
 * some doulists have sparse pages from removed entries.
 *
 * @param {string} doulistId
 * @param {{ delayMs?: number, onPage?: (info: {start: number, count: number}) => void }} [opts]
 * @returns {Promise<Array<{ dbid: string, title: string, abstract: string, comment: string, year: string | null }>>}
 */
export async function scrapeDoulistAll(doulistId, opts = {}) {
    const delayMs = opts.delayMs ?? 3000;
    const entries = [];
    let start = 0;
    while (true) {
        const url = `https://www.douban.com/doulist/${doulistId}/?start=${start}`;
        const res = await fetchViaCurl(url);
        if (res.status !== 200) {
            throw new Error(`doulist ${doulistId} HTTP ${res.status} at start=${start}`);
        }
        const $ = cheerio.load(res.body);
        const items = $('.doulist-item').toArray();
        opts.onPage?.({ start, count: items.length });
        if (items.length === 0) break;
        for (const el of items) {
            const $el = $(el);
            const href = $el.find('.title a').attr('href') || '';
            const m = href.match(/subject\/(\d+)/);
            if (!m) continue;
            const dbid = m[1];
            const title = $el.find('.title a').text().trim();
            const abstract = $el.find('.abstract').text().replace(/\s+/g, ' ').trim();
            const comment = $el.find('.ft blockquote.comment').text().replace(/\s+/g, ' ').trim();
            // Year from 评语 by default; callers wanting Douban's `年份:
            // YYYY` from .abstract extract it themselves.
            const yearMatch = comment.match(/(\d{4})/);
            const year = yearMatch ? yearMatch[1] : null;
            if (title && dbid) entries.push({ dbid, title, abstract, comment, year });
        }
        start += 25;
        await sleep(delayMs);
    }
    return entries;
}

const CN_NUM_TO_INT = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ROMAN_LOWER_TO_INT = { 'ⅰ': 1, 'ⅱ': 2, 'ⅲ': 3, 'ⅳ': 4, 'ⅴ': 5, 'ⅵ': 6, 'ⅶ': 7, 'ⅷ': 8, 'ⅸ': 9, 'ⅹ': 10 };
const ASCII_ROMAN_TO_INT = { ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/**
 * Normalize a title for fuzzy matching:
 *   1. Collapse sequel markers (第X季 / Season X / II / Ⅱ / ii) to a
 *      single "s<N>" token so "灵能百分百 第二季" matches "灵能百分百 II
 *      モブサイコ100 II" despite otherwise disjoint char sets.
 *   2. Lowercase, strip everything except CJK + ASCII alphanumerics +
 *      spaces, then drop spaces.
 *
 * The output is meant for substring tests and character-set Jaccard;
 * it is not a reversible canonical form.
 *
 * @param {string} s
 * @returns {string}
 */
export function normalizeForMatch(s) {
    let t = String(s).toLowerCase();
    t = t.replace(/第([一二三四五六七八九十])季/g, (_, n) => ` s${CN_NUM_TO_INT[n]} `);
    t = t.replace(/第(\d+)季/g, (_, n) => ` s${n} `);
    t = t.replace(/\bseason\s*(\d+)\b/gi, (_, n) => ` s${n} `);
    t = t.replace(/[ⅰ-ⅹ]/g, ch => ` s${ROMAN_LOWER_TO_INT[ch] ?? ''} `);
    t = t.replace(/\b(iii|ii|iv|viii|vii|vi|v|ix|x)\b/g, (_, r) => ` s${ASCII_ROMAN_TO_INT[r] ?? ''} `);
    return t.replace(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-z0-9 ]/gu, '').replace(/\s+/g, '');
}

/**
 * Jaccard similarity over character sets. Accepts already-normalized or
 * raw strings; normalize first if you want consistent results.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}  0-1
 */
export function jaccardScore(a, b) {
    const sa = new Set(a);
    const sb = new Set(b);
    if (sa.size === 0 || sb.size === 0) return 0;
    let inter = 0;
    for (const ch of sa) if (sb.has(ch)) inter++;
    return inter / (sa.size + sb.size - inter);
}
