# Adding a Data Source

本指南介绍如何给 `douban-rankings` 添加一个新的外部榜单数据源（source）。

## 动手前：scope 自检

加新 source 前先自问：**豆瓣自己是不是已经展示这份榜单 / 奖项？**

- ❌ **不加**：豆瓣 Top 250、subject_collection、条目页 `<ul class="award">` 已覆盖的奖项（奥斯卡 / 金球 / BAFTA / 戛纳 etc.）
- ✅ **值得加**：豆瓣没展示的外部权威榜单（IMDb Top 250、Criterion Collection、BFI Sight & Sound、TSPDT 1000 等）

本项目是 **complement**，不是 **replacement**。重复爬豆瓣已经展示的榜单，对用户毫无新信息价值。

## 目录约定

```
src/sources/<source-id>.mjs           Source 模块
test/sources/<source-id>.test.mjs     单测
test/sources/fixtures/                HTML / TSV 样本（若需）
```

`<source-id>` 用 kebab-case，比如 `imdb-top250`、`criterion`、`bfi-sight-sound-2022`。

## Source 模块契约

```js
// src/sources/<your-source>.mjs

export default {
    id: 'your-source-id',              // 唯一，kebab-case
    category: 'movie',                 // movie | book | music | tv | ...（v1 只 movie）
    subCategory: 'movie',              // 同 category 下的细分
    kind: 'permanent',                 // permanent | yearly | periodic
    priority: 3,                       // UI 排序权重，小的靠前
    externalIdKind: 'imdb',            // pipeline 据此路由到 matcher
    meta: {
        title: 'Human-readable Title',
        titleZh: '中文标题',
        url: 'https://example.com/canonical-ranking-page',
    },

    /**
     * @param {HttpClient} http  必须通过 src/util/http.mjs 创建的 client
     * @returns {Promise<Array<{ externalId, rank, title }>>}
     */
    async scrape(http) {
        // ...
    },
};
```

**字段说明**：

| 字段 | 用途 |
|---|---|
| `id` | 产出 JSON 里 `items[].source` 的值；唯一 |
| `category` | 决定进哪个 `<category>.json` 文件 |
| `kind` | `permanent`（永久殿堂）/ `yearly`（年度）/ `periodic`（周/月） |
| `priority` | userscript UI 排序权重 |
| `externalIdKind` | `imdb` / `title-year` / `bangumi` / ... — 决定 pipeline 调哪个 matcher |
| `meta.url` | 用户点击查看原榜单的页面 URL |

## 实现 `scrape(http)`

### 规则

1. **必须走 `src/util/http.mjs` 的 HTTP client**：限速、退避、UA、重试都集中在那。直接用全局 `fetch` 会绕开限速策略，可能让 run 被目标站点封。
2. **返回 plain object 数组**，每条 `{ externalId, rank, title }`：
   - `externalId`: 被 matcher 反查成豆瓣 subject id 的外部 id（IMDb tt id、条目名+年份 hash 等，取决于 `externalIdKind`）
   - `rank`: 榜单内排名（1-based）；无排名时填 `null`
   - `title`: 显示用的标题，主要给 debug log 和 unresolved 列表用

### 示例：优先 JSON-LD 或官方 dataset

如果站点提供机器可读数据（schema.org JSON-LD、官方 TSV datasets、RSS 等），**优先用它们**：更稳定，不受站点 DOM 重构影响，通常也不碰反爬。

参考 `src/sources/imdb-top250.mjs`：它用 IMDb 官方 non-commercial datasets（TSV over HTTPS），流式解析，避免爬页面被 AWS WAF 挡。

### 示例：HTML scraping

需要解析 HTML 时用 `cheerio`（已在依赖里）：

```js
import * as cheerio from 'cheerio';

async scrape(http) {
    const res = await http.fetch('https://example.com/ranking');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const $ = cheerio.load(await res.text());
    const items = [];
    $('.ranking-item').each((i, el) => {
        items.push({
            externalId: $(el).attr('data-imdb-id'),
            rank: i + 1,
            title: $(el).find('.title').text().trim(),
        });
    });
    return items;
}
```

## Matcher：把 `externalId` 变成豆瓣 subject id

`externalIdKind` 决定 pipeline 用哪个 matcher。当前注册表在 `src/pipeline.mjs`：

```js
const DEFAULT_MATCHERS = {
    imdb: matchImdbToDouban,
    // 未来：'bangumi': matchBangumiToDouban, ...
};
```

**如果你的 source 用现有 `externalIdKind`**（如 `'imdb'`）：直接用，pipeline 会自动路由。

**如果是新种类**（比如 Bangumi ID）：
1. 在 `src/matchers/` 新建 matcher 模块，export 一个 `async (externalId, http, options?) => Promise<string | null>` 函数
2. 在 `pipeline.mjs` 的 `DEFAULT_MATCHERS` 里注册新 key
3. source 的 `externalIdKind` 设成这个 key

**始终返回 `null` 而非 throw**——未解析的条目被 pipeline 自然 drop，并 log 到 unresolved 列表供人工补 `config/manual-mapping.yaml`。

## 限速策略

pipeline 启动时读 `DEFAULT_RATE_LIMITS`（`src/pipeline.mjs`）：

```js
const DEFAULT_RATE_LIMITS = {
    'search.douban.com': { minDelay: 5000 },  // 豆瓣是 bottleneck
    'www.imdb.com': { minDelay: 2000 },
    'www.criterion.com': { minDelay: 2000 },
    // ...
};
```

新 source 访问新 hostname 时请在此加一行。**保守起见从 2s/req 起**，只有确认目标站点不 care 才放宽。**豆瓣相关一律 5s/req 起步**（参照 PRD 反爬策略）。

## 测试

```js
// test/sources/<your-source>.test.mjs
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import source from '../../src/sources/<your-source>.mjs';

test('exposes stable source metadata', () => {
    assert.equal(source.id, 'your-source-id');
    assert.equal(source.category, 'movie');
    assert.equal(source.externalIdKind, 'imdb');
});

test('scrape() parses fixture and returns well-shaped items', async () => {
    const fakeHttp = {
        async fetch() {
            return new Response(/* fixture content */, { status: 200 });
        },
    };
    const items = await source.scrape(fakeHttp);
    assert.ok(items.length > 0);
    assert.match(items[0].externalId, /^tt\d+$/);
});
```

**不要在单测里打真实网络**。用 `fakeHttp` mock + fixture 文件。运行时验证留给 `pnpm run update` 实机试跑。

## 注册到 pipeline

在 `src/pipeline.mjs` 顶部加 import，并加到 `DEFAULT_SOURCES`：

```js
import yourSource from './sources/<your-source>.mjs';

const DEFAULT_SOURCES = [imdbTop250, yourSource];
```

## 提交 checklist

- [ ] `pnpm test` 全绿
- [ ] 至少一次本地 `pnpm run update` 样本跑通（不一定要完整产出，早期失败也算 sample）
- [ ] `DEFAULT_RATE_LIMITS` 里加了新 hostname（如需）
- [ ] README / CLAUDE.md 不需要改（source 列表从运行时读，不维护静态列表）
- [ ] PR 描述里简述榜单选择理由 + scope 自检结论

## 常见坑

- **目标站点上了 AWS WAF / Cloudflare challenge**：纯 HTTP fetch 会被挡。检查是否有官方 dataset（如 IMDb）或 social / API 替代。最后才考虑 Playwright（重，维护成本高）。
- **scrape 返回 `rank: undefined`**：pipeline 会 log 但保留条目，最终 JSON 里 `rank: null`。若榜单确实无顺序（如 "Criterion Collection membership"），显式返回 `null` 并依赖 `spineNumber` 等辅助字段。
- **externalId 大小写**：IMDb tt id 一律小写 `tt0111161`。PtGen map 也是小写 key。
- **重复抓取**：pipeline 对每个 source 只调 `scrape` 一次，pipeline 内存里 dedupe 不需要你做。

## 参考

- `src/sources/imdb-top250.mjs` — 官方 dataset + 流式 TSV 的完整样例
- `src/util/http.mjs` — HTTP client 的完整接口
- `CLAUDE.md` → "核心架构"一节 — 全局设计图
