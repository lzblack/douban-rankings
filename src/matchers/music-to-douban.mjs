import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const DEFAULT_MAPPING_PATH = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'config',
    'manual-mapping.yaml',
);

let _cached;

function loadDefaultMapping() {
    if (_cached !== undefined) return _cached;
    try {
        _cached = parseYaml(readFileSync(DEFAULT_MAPPING_PATH, 'utf-8')) ?? {};
    } catch (err) {
        if (err.code === 'ENOENT') _cached = {};
        else throw err;
    }
    return _cached;
}

/**
 * Resolve an album (by title + artist) to Douban music subject id(s).
 *
 * Strategy mirrors book matcher but targets the music search endpoint:
 *   1. manual-mapping.yaml `music` section, key "normalized-title|artist"
 *      or title-only. Single or array value (different pressings /
 *      remasters may have separate Douban subjects).
 *   2. search.douban.com/music/subject_search parsed from window.__DATA__;
 *      pick the first item whose rating exists (avoids bootleg/mix entries).
 *
 * @param {{ title: string, artist?: string }} query
 * @param {{ fetch: Function }} http
 * @param {{
 *   manualMapping?: { music?: Record<string, string | string[] | number> },
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function matchMusicToDouban(query, http, options = {}) {
    const { title, artist } = query;
    if (!title) return [];

    const mapping = options.manualMapping ?? loadDefaultMapping();
    const keys = [
        manualMappingKey(title, artist),
        manualMappingKey(title, ''),
    ];
    for (const k of keys) {
        if (!k) continue;
        const hit = mapping?.music?.[k];
        if (hit != null) {
            return Array.isArray(hit) ? hit.map(String) : [String(hit)];
        }
    }

    const q = artist ? `${title} ${artist}` : title;
    const url = `https://search.douban.com/music/subject_search?search_text=${encodeURIComponent(q)}`;
    const res = await http.fetch(url);
    if (!res.ok) return [];
    const html = await res.text();
    const m = html.match(/window\.__DATA__\s*=\s*(\{[\s\S]*?\});/);
    if (!m) return [];
    let data;
    try {
        data = JSON.parse(m[1]);
    } catch {
        return [];
    }
    const items = Array.isArray(data?.items) ? data.items : [];
    if (items.length === 0) return [];

    // Prefer first item that has a rating (weeds out dud bootleg entries
    // whose subject pages are minimal stubs).
    const withRating = items.find(it => it?.rating?.value);
    const pick = withRating ?? items[0];
    return pick?.id ? [String(pick.id)] : [];
}

export function manualMappingKey(title, artist) {
    return `${normalizeMusicKey(title)}|${normalizeMusicKey(artist ?? '')}`;
}

function normalizeMusicKey(s) {
    return String(s)
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[.,:;!?'"()\[\]{}\u2018\u2019\u201c\u201d]/g, '')
        .replace(/[-_/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
