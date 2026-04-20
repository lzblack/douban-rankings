import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source: Bangumi (bgm.tv) Top 250 anime.
 *
 * Douban hosts anime as movie subjects under `movie.douban.com/subject/*`,
 * so the output lives in `movie.json` (category='movie'). subCategory
 * 'anime' is set so consumers can style anime badges differently.
 *
 * Pre-resolved snapshot model (distinct from Criterion/BFI/Letterboxd's
 * data-only snapshots):
 *
 *   - IMDB datasets don't index TV series; `matchTitleYearToDouban`'s
 *     Layer 2 (IMDB title → PtGen) almost always misses for anime.
 *   - Layer 3 (Douban search) is the only reliable path. Running 250
 *     searches on every cold start from an Actions runner IP would
 *     trip Douban's anti-scrape within minutes.
 *   - Solution: the maintainer fetch script runs the Douban search
 *     locally once (residential IP, polite 5s/req), produces an
 *     already-resolved snapshot {rank, bangumiId, title, year,
 *     doubanId}. The pipeline reads this snapshot and needs zero
 *     matcher calls — 100% resolution, zero Douban traffic in CI.
 *
 * Fetcher: `pnpm run fetch:bangumi-top250-snapshot`. Cadence: quarterly
 * is plenty — Top 250 anime doesn't churn fast.
 */

const DEFAULT_SNAPSHOT_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'bangumi-top250-snapshot.json',
);

/** @typedef {{ externalId: string, rank: number, title: string, year: string, bangumiId: string, doubanId?: string }} ScrapedItem */

export default {
    id: 'bangumi-top250',
    category: 'movie',
    subCategory: 'anime',
    kind: 'yearly',
    priority: 7,
    externalIdKind: 'pre-resolved',
    meta: {
        title: 'Bangumi Anime Top 250',
        titleZh: 'Bangumi 动画 Top 250',
        url: 'https://bgm.tv/anime/browser?sort=rank',
    },
    formatLabel: it => (it.rank == null ? null : `No.${it.rank}`),

    /**
     * @param {{ fetch: Function }} _http
     * @param {{ snapshotPath?: string }} [opts]
     * @returns {Promise<ScrapedItem[]>}
     */
    async scrape(_http, opts = {}) {
        const snapshotPath = opts.snapshotPath ?? DEFAULT_SNAPSHOT_PATH;
        let raw;
        try {
            raw = await readFile(snapshotPath, 'utf-8');
        } catch (err) {
            if (err.code === 'ENOENT') {
                throw new Error(
                    'bangumi-top250: ' +
                        snapshotPath +
                        ' not found. Run `pnpm run fetch:bangumi-top250-snapshot` from a residential IP and commit the generated file.',
                );
            }
            throw err;
        }
        const data = JSON.parse(raw);
        return Array.isArray(data?.items) ? data.items : [];
    },

    /**
     * Snapshot pre-resolves douban ids during fetch, so matchItem just
     * returns `[doubanId]` with zero remote calls. ctx.prevResolved is
     * still honored for entries that lost their doubanId somehow.
     *
     * @param {ScrapedItem} raw
     * @param {{ fetch: Function }} _http
     * @param {{ prevResolved?: Map<string, Map<string, string[]>> }} [ctx]
     */
    async matchItem(raw, _http, ctx = {}) {
        if (raw.doubanId) return [String(raw.doubanId)];
        const cached = ctx.prevResolved?.get('bangumi-top250')?.get(raw.externalId);
        if (Array.isArray(cached) && cached.length) return cached;
        return [];
    },
};

/**
 * Parse a Bangumi anime browser page. Exported for the fetch script.
 * Each item is `<li id="item_<bangumiId>">` with Chinese title and
 * air date info.
 *
 * @param {string} html
 */
export function parseList(html) {
    // Lightweight regex parse (no cheerio dep here so the fetch script
    // can be lean; cheerio is still a runtime dep if we ever need it).
    const items = [];
    const liRe = /<li[^>]*id="item_(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
    let liMatch;
    while ((liMatch = liRe.exec(html)) !== null) {
        const bangumiId = liMatch[1];
        const body = liMatch[2];

        const titleCnMatch = body.match(/<h3[^>]*>[\s\S]*?<a[^>]*class="l"[^>]*>([^<]+)<\/a>/);
        const titleJpMatch = body.match(/<small[^>]*class="grey"[^>]*>([^<]+)<\/small>/);
        const title = (titleCnMatch?.[1] || titleJpMatch?.[1] || '').trim();

        // Rank markup varies: `<span class="rank">Rank <b>N</b></span>` in
        // older pages, `<span class="rank"><small>Rank </small>N</span>`
        // in newer; take the first integer that follows the "rank" class
        // opening to cover both.
        const rankMatch = body.match(/class="rank"[^>]*>[\s\S]*?(\d+)/);
        if (!rankMatch) continue;
        const rank = Number(rankMatch[1]);

        const info = body.match(/<p[^>]*class="info[^"]*"[^>]*>([^<]+)</);
        const yearMatch = info?.[1]?.match(/(19|20)\d{2}/);
        const year = yearMatch ? yearMatch[0] : '';

        if (!title || !year) continue;
        items.push({
            externalId: `bangumi-${bangumiId}`,
            rank,
            title,
            year,
            bangumiId,
        });
    }
    return items;
}
