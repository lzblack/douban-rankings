import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
    matchBookToDouban,
    manualMappingKey,
} from '../../src/matchers/book-to-douban.mjs';

function mockHttp(handler) {
    return { fetch: async (url, init) => handler(url, init) };
}

test('manualMappingKey normalizes title + author', () => {
    assert.equal(
        manualMappingKey('The English Patient', 'Michael Ondaatje'),
        'the english patient|michael ondaatje',
    );
    assert.equal(
        manualMappingKey('Beloved', ''),
        'beloved|',
    );
});

test('manual mapping by title+author wins', async () => {
    const http = mockHttp(() => {
        throw new Error('should not be called');
    });
    const ids = await matchBookToDouban(
        { title: 'Beloved', author: 'Toni Morrison' },
        http,
        {
            manualMapping: {
                books: { 'beloved|toni morrison': '1007200' },
            },
        },
    );
    assert.deepEqual(ids, ['1007200']);
});

test('manual mapping by title-only fallback', async () => {
    const http = mockHttp(() => {
        throw new Error('should not be called');
    });
    const ids = await matchBookToDouban(
        { title: 'Beloved', author: 'Toni Morrison' },
        http,
        {
            manualMapping: {
                books: { 'beloved|': '1007200' },
            },
        },
    );
    assert.deepEqual(ids, ['1007200']);
});

test('manual mapping accepts array value for multi-edition', async () => {
    const http = mockHttp(() => {
        throw new Error('unused');
    });
    const ids = await matchBookToDouban(
        { title: 'The Great Gatsby', author: 'F. Scott Fitzgerald' },
        http,
        {
            manualMapping: {
                books: {
                    'the great gatsby|f scott fitzgerald': ['1000000', '1000001'],
                },
            },
        },
    );
    assert.deepEqual(ids, ['1000000', '1000001']);
});

test('falls through to Douban book search, picks first item id', async () => {
    const html = `<script>window.__DATA__ = ${JSON.stringify({
        items: [
            { id: 1007200, title: '宠儿' },
            { id: 9999999, title: '另一本同名书' },
        ],
    })};</script>`;
    const http = mockHttp(async url => {
        assert.match(url, /search\.douban\.com\/book\/subject_search/);
        return new Response(html, { status: 200 });
    });
    const ids = await matchBookToDouban(
        { title: 'Beloved', author: 'Toni Morrison' },
        http,
        { manualMapping: {} },
    );
    assert.deepEqual(ids, ['1007200']);
});

test('returns [] when search returns empty', async () => {
    const html = `<script>window.__DATA__ = ${JSON.stringify({ items: [] })};</script>`;
    const http = mockHttp(async () => new Response(html, { status: 200 }));
    const ids = await matchBookToDouban(
        { title: 'No Such Book', author: 'Nobody' },
        http,
        { manualMapping: {} },
    );
    assert.deepEqual(ids, []);
});

test('returns [] on non-OK response', async () => {
    const http = mockHttp(async () => new Response('blocked', { status: 403 }));
    const ids = await matchBookToDouban(
        { title: 'x', author: 'y' },
        http,
        { manualMapping: {} },
    );
    assert.deepEqual(ids, []);
});

test('returns [] when title missing', async () => {
    const http = mockHttp(() => {
        throw new Error('unused');
    });
    const ids = await matchBookToDouban(
        { title: '', author: 'someone' },
        http,
        { manualMapping: {} },
    );
    assert.deepEqual(ids, []);
});
