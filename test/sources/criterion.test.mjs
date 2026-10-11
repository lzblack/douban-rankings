import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import source, {
    parseList,
    parseWikipediaList,
    addPublishedSpines,
} from '../../src/sources/criterion.mjs';

const FIXTURE_HTML = `
<table>
  <thead>
    <tr class="gridview__index">
      <th class="g-spine">Spine #</th>
      <th class="g-img"></th>
      <th class="g-title">Title</th>
      <th class="g-director">Director</th>
      <th class="g-country">Country</th>
      <th class="g-year">Year</th>
    </tr>
  </thead>
  <tbody>
    <tr class="gridFilm" data-role="grid-film" data-href="https://www.criterion.com/films/27897-grand-illusion">
      <td class="g-spine">0001</td>
      <td class="g-img"></td>
      <td class="g-title"><span>Grand Illusion</span></td>
      <td class="g-director">Jean Renoir</td>
      <td class="g-country">France</td>
      <td class="g-year">1937</td>
    </tr>
    <tr class="gridFilm" data-role="grid-film" data-href="https://www.criterion.com/films/28097-seven-samurai">
      <td class="g-spine">0002</td>
      <td class="g-img"></td>
      <td class="g-title"><span>Seven Samurai</span></td>
      <td class="g-director">Akira Kurosawa</td>
      <td class="g-country">Japan</td>
      <td class="g-year">1954</td>
    </tr>
    <tr class="gridFilm" data-role="grid-film" data-href="https://www.criterion.com/films/99999-empty-title">
      <td class="g-spine">0003</td>
      <td class="g-img"></td>
      <td class="g-title"></td>
      <td class="g-director">Unknown</td>
      <td class="g-country">Unknown</td>
      <td class="g-year">2000</td>
    </tr>
  </tbody>
</table>`;

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'criterion');
    assert.equal(source.category, 'movie');
    assert.equal(source.kind, 'permanent');
    assert.equal(source.priority, 2);
    assert.equal(source.externalIdKind, 'title-year');
    assert.ok(source.meta.title);
});

test('parseList extracts spine, title, year, slug; skips rows without title', () => {
    const items = parseList(FIXTURE_HTML);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], {
        externalId: '0001',
        rank: null,
        spineNumber: '0001',
        title: 'Grand Illusion',
        year: '1937',
        slug: 'grand-illusion',
    });
    assert.equal(items[1].externalId, '0002');
    assert.equal(items[1].title, 'Seven Samurai');
    assert.equal(items[1].year, '1954');
});

test('scrape() reads snapshot file when present (no network)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'criterion-snap-'));
    try {
        const snapshotPath = join(dir, 'snap.json');
        await writeFile(
            snapshotPath,
            JSON.stringify({
                generatedAt: '2026-04-18T00:00:00Z',
                items: [
                    { externalId: '0001', rank: null, title: 'A', year: '1937' },
                    { externalId: '0002', rank: null, title: 'B', year: '1954' },
                ],
            }),
        );
        const http = {
            fetch: () => {
                throw new Error('scrape must not touch the network');
            },
        };
        const items = await source.scrape(http, { snapshotPath });
        assert.equal(items.length, 2);
        assert.equal(items[0].externalId, '0001');
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('scrape() throws with helpful instructions when snapshot missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'criterion-nosnap-'));
    try {
        const snapshotPath = join(dir, 'does-not-exist.json');
        const http = { fetch: () => { throw new Error('unused'); } };
        await assert.rejects(
            () => source.scrape(http, { snapshotPath }),
            /not found.*fetch:criterion-snapshot/,
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('matchItem returns cached array from ctx.prevResolved without touching http', async () => {
    const http = {
        fetch: () => {
            throw new Error('http should not be called on cache hit');
        },
    };
    const ctx = {
        prevResolved: new Map([
            ['criterion', new Map([['0001', ['1294808', '34447553']]])],
        ]),
    };
    const ids = await source.matchItem(
        { externalId: '0001', rank: null, title: 'Grand Illusion', year: '1937' },
        http,
        ctx,
    );
    assert.deepEqual(ids, ['1294808', '34447553']);
});

// Distilled from the Parsoid HTML of en.wikipedia.org "List of films in the
// Criterion Collection" (2026-10): footnote <sup>s inside spine cells,
// sortname spans, rowspans across box-set rows, N/A film spines, and the
// Eclipse table (own numbering, no "Spine" column).
const WIKI_FIXTURE_HTML = `
<h2>List of individually-released films</h2>
<table class="wikitable sortable">
  <tbody>
    <tr><th>Spine</th><th>Film</th><th>Film Release Year</th><th>Director</th><th>Country</th><th>Notes</th></tr>
    <tr class="mw-empty-elt"></tr>
    <tr style="background-color:#FFFAE6">
      <td>1<sup class="mw-ref reference"><a href="#cite_note-1">[a]</a></sup></td>
      <td><i><a href="./La_Grande_Illusion" title="La Grande Illusion">Grand Illusion</a></i><sup>†</sup></td>
      <td>1937</td>
      <td><span data-sort-value="Renoir, Jean"><span class="vcard"><span class="fn"><a href="./Jean_Renoir">Jean Renoir</a></span></span></span></td>
      <td>France</td><td>First French film</td>
    </tr>
    <tr>
      <td>2</td>
      <td><i><span data-sort-value="Seven Samurai"><a href="./Seven_Samurai">Seven Samurai</a></span></i></td>
      <td>1954</td><td>Akira Kurosawa</td><td>Japan</td><td></td>
    </tr>
    <tr><td>3</td><td></td><td>1999</td><td>Nobody</td><td>US</td><td></td></tr>
  </tbody>
</table>
<h2>List of films released in box sets</h2>
<table class="wikitable sortable">
  <tbody>
    <tr><th>Spine</th><th>Name of box set</th><th>Spine number (of film)</th><th>Included films</th><th>Year</th><th>Director</th><th>Notes</th></tr>
    <tr>
      <td rowspan="3">66</td>
      <td rowspan="3">The Orphic Trilogy</td>
      <td>67<sup class="mw-ref reference"><a href="#cite_note-2">[b]</a></sup></td>
      <td><i><span data-sort-value="Blood of a Poet, The"><a href="./The_Blood_of_a_Poet">The Blood of a Poet</a></span></i><sup>†</sup></td>
      <td>1930</td>
      <td rowspan="3">Jean Cocteau</td>
      <td rowspan="4"></td>
    </tr>
    <tr><td>68</td><td><i><a href="./Orpheus_(film)">Orpheus</a></i></td><td>1950</td></tr>
    <tr><td>69</td><td><i><a href="./Testament_of_Orpheus">Testament of Orpheus</a></i></td><td>1959</td></tr>
    <tr>
      <td rowspan="2">79</td>
      <td rowspan="2">W.C. Fields - Six Short Films</td>
      <td rowspan="2">N/A</td>
      <td><i>The Golf Specialist</i></td><td>1930</td><td>Monte Brice</td>
    </tr>
    <tr><td><i>Pool Sharks</i></td><td>1915</td><td>Edwin Middleton</td><td>Oldest film</td></tr>
  </tbody>
</table>
<h2>List of films in director box sets</h2>
<table class="wikitable sortable">
  <tbody>
    <tr><th>Name of box set</th><th>Spine number (of film)</th><th>Included films</th><th>Year</th><th>Director</th><th>Notes</th></tr>
    <tr>
      <td rowspan="3">Ingmar Bergman's Cinema</td>
      <td rowspan="2">N/A</td>
      <td><i>Crisis</i></td><td>1946</td>
      <td rowspan="3">Ingmar Bergman</td><td></td>
    </tr>
    <tr><td><i>A Ship to India</i></td><td>1947</td><td></td></tr>
    <tr><td>2</td><td><i>Seven Samurai (duplicate spine)</i></td><td>1954</td><td></td></tr>
  </tbody>
</table>
<h2>List of films in the Eclipse series</h2>
<table class="wikitable sortable">
  <tbody>
    <tr><th>Series</th><th>Name of Eclipse series</th><th>Included Films</th><th>Year</th><th>Director</th></tr>
    <tr><td rowspan="2">1</td><td rowspan="2">Early Bergman</td><td><i>Torment</i></td><td>1944</td><td>Alf Sjöberg</td></tr>
    <tr><td><i>Crisis</i></td><td>1946</td><td>Ingmar Bergman</td></tr>
  </tbody>
</table>
`;

test('parseWikipediaList reads film-level spines across individual and box-set tables', () => {
    const items = parseWikipediaList(WIKI_FIXTURE_HTML);
    assert.deepEqual(
        items.map(it => [it.externalId, it.title, it.year]),
        [
            ['1', 'Grand Illusion', '1937'],
            ['2', 'Seven Samurai', '1954'],
            ['67', 'The Blood of a Poet', '1930'],
            ['68', 'Orpheus', '1950'],
            ['69', 'Testament of Orpheus', '1959'],
            // Box set whose films carry no spine of their own: the set is
            // one release under its own spine (as criterion.com listed it).
            ['79', 'W.C. Fields - Six Short Films', '1930'],
        ],
    );
});

test('parseWikipediaList shapes items like the snapshot the pipeline reads', () => {
    const [first] = parseWikipediaList(WIKI_FIXTURE_HTML);
    assert.deepEqual(first, {
        externalId: '1',
        rank: null,
        spineNumber: '1',
        title: 'Grand Illusion',
        year: '1937',
    });
});

test('parseWikipediaList throws when no spine table is found', () => {
    assert.throws(() => parseWikipediaList('<p>page moved</p>'), /no spine/i);
});

test('addPublishedSpines keeps previously published spines missing from the new list', () => {
    const parsed = [
        { externalId: '1', rank: null, spineNumber: '1', title: 'Grand Illusion', year: '1937' },
    ];
    const published = {
        categories: {
            movie: {
                items: {
                    '1294808': [{ source: 'criterion', externalId: '1' }],
                    '1300067': [
                        { source: 'criterion', externalId: '188' },
                        { source: 'letterboxd-top250', externalId: 'tt0101798' },
                    ],
                    '9999999': [{ source: 'criterion', externalId: '188' }],
                },
            },
        },
    };
    const merged = addPublishedSpines(parsed, published);
    assert.deepEqual(merged, [
        parsed[0],
        { externalId: '188', rank: null, spineNumber: '188', title: '', year: '' },
    ]);
});

test('addPublishedSpines is a no-op without a usable published payload', () => {
    const parsed = [{ externalId: '1', rank: null, spineNumber: '1', title: 'A', year: '1937' }];
    assert.deepEqual(addPublishedSpines(parsed, null), parsed);
    assert.deepEqual(addPublishedSpines(parsed, { schemaVersion: 1 }), parsed);
});
