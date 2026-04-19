import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
    matchMusicToDouban,
    manualMappingKey,
} from '../../src/matchers/music-to-douban.mjs';

function mockHttp(handler) {
    return { fetch: async (url, init) => handler(url, init) };
}

test('manualMappingKey normalizes title + artist', () => {
    assert.equal(
        manualMappingKey('Abbey Road', 'The Beatles'),
        'abbey road|the beatles',
    );
});

test('manual mapping wins', async () => {
    const http = mockHttp(() => {
        throw new Error('should not be called');
    });
    const ids = await matchMusicToDouban(
        { title: 'Abbey Road', artist: 'The Beatles' },
        http,
        {
            manualMapping: {
                music: { 'abbey road|the beatles': '1401361' },
            },
        },
    );
    assert.deepEqual(ids, ['1401361']);
});

test('manual mapping array supports multi-edition', async () => {
    const http = mockHttp(() => {
        throw new Error('unused');
    });
    const ids = await matchMusicToDouban(
        { title: 'Abbey Road', artist: 'The Beatles' },
        http,
        {
            manualMapping: {
                music: {
                    'abbey road|the beatles': ['1401361', '27110924'],
                },
            },
        },
    );
    assert.deepEqual(ids, ['1401361', '27110924']);
});

test('prefers search result with rating, skipping dud entries', async () => {
    const html = `<script>window.__DATA__ = ${JSON.stringify({
        items: [
            { id: 999, title: 'Bootleg entry (no rating)' },
            { id: 1401361, title: 'Abbey Road', rating: { value: 9.6 } },
            { id: 222, title: 'Another Abbey Road', rating: { value: 8.0 } },
        ],
    })};</script>`;
    const http = mockHttp(async url => {
        assert.match(url, /search\.douban\.com\/music\/subject_search/);
        return new Response(html, { status: 200 });
    });
    const ids = await matchMusicToDouban(
        { title: 'Abbey Road', artist: 'The Beatles' },
        http,
        { manualMapping: {} },
    );
    assert.deepEqual(ids, ['1401361']);
});

test('falls back to first result when none have ratings', async () => {
    const html = `<script>window.__DATA__ = ${JSON.stringify({
        items: [
            { id: 111, title: 'x' },
            { id: 222, title: 'y' },
        ],
    })};</script>`;
    const http = mockHttp(async () => new Response(html, { status: 200 }));
    const ids = await matchMusicToDouban(
        { title: 'x', artist: 'nobody' },
        http,
        { manualMapping: {} },
    );
    assert.deepEqual(ids, ['111']);
});

test('returns [] on empty search or non-OK', async () => {
    const http1 = mockHttp(async () => new Response(`<script>window.__DATA__ = {"items":[]};</script>`, { status: 200 }));
    assert.deepEqual(
        await matchMusicToDouban({ title: 'x', artist: 'y' }, http1, { manualMapping: {} }),
        [],
    );
    const http2 = mockHttp(async () => new Response('blocked', { status: 403 }));
    assert.deepEqual(
        await matchMusicToDouban({ title: 'x', artist: 'y' }, http2, { manualMapping: {} }),
        [],
    );
});
