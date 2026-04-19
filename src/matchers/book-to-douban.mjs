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
 * Resolve a book (by title + optional author) to every known Douban
 * book subject id.
 *
 * Books diverge from films in two ways that matter here:
 *   1. No PtGen-style (ISBN → douban) aggregate map we can consult.
 *   2. Book titles are more distinctive than film titles (author-specific,
 *      less remake collisions), so first-result-match is usually correct.
 *
 * Strategy:
 *   1. manual-mapping.yaml `books` section (key = "normalized-title|author"
 *      or just "normalized-title"), single or array value
 *   2. search.douban.com/book/subject_search parsed from window.__DATA__;
 *      pick the first item.
 *
 * Returns a string[] (possibly multiple Douban subjects for different
 * translations / editions) consistent with the other matchers.
 *
 * @param {{ title: string, author?: string, year?: string | number }} query
 * @param {{ fetch: Function }} http
 * @param {{
 *   manualMapping?: { books?: Record<string, string | string[] | number> },
 * }} [options]
 * @returns {Promise<string[]>}
 */
export async function matchBookToDouban(query, http, options = {}) {
    const { title, author } = query;
    if (!title) return [];

    // Layer 1: manual mapping. Try title+author, then title-only.
    const mapping = options.manualMapping ?? loadDefaultMapping();
    const keys = [
        manualMappingKey(title, author),
        manualMappingKey(title, ''),
    ];
    for (const k of keys) {
        if (!k) continue;
        const hit = mapping?.books?.[k];
        if (hit != null) {
            return Array.isArray(hit)
                ? hit.map(String)
                : [String(hit)];
        }
    }

    // Layer 2: Douban book search
    const q = author ? `${title} ${author}` : title;
    const url = `https://search.douban.com/book/subject_search?search_text=${encodeURIComponent(q)}`;
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
    const first = items[0];
    return first?.id ? [String(first.id)] : [];
}

/** Stable key the curator can write into manual-mapping.yaml. */
export function manualMappingKey(title, author) {
    return `${normalizeBookKey(title)}|${normalizeBookKey(author ?? '')}`;
}

function normalizeBookKey(s) {
    return String(s)
        .toLowerCase()
        .replace(/&/g, 'and')
        .replace(/[.,:;!?'"()\[\]{}\u2018\u2019\u201c\u201d]/g, '')
        .replace(/[-_/\\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
