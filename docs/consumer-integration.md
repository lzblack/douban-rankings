# Consumer Integration Guide

本文档面向希望消费 `douban-rankings` 发布数据的项目——典型场景是 userscript / 浏览器扩展，在豆瓣条目页上渲染"IMDb Top 250"、"Criterion Collection"等外部榜单标签。

主要 consumer：`lzblack/userscripts/douban-rating-hub.user.js`。

---

## Endpoints

所有 URL 均 `GET`，HTTPS，`Access-Control-Allow-Origin: *`（可从任何 origin 读取）。

| URL | 用途 | 何时读 |
|---|---|---|
| `https://rank.douban.zhili.dev/manifest.json` | 可用 category 列表 | 启动时一次 |
| `https://rank.douban.zhili.dev/movie.json` | 电影品类完整反向索引 | 页面 match `movie.douban.com/subject/*` 时 |
| `https://rank.douban.zhili.dev/health.json` | 抓取健康状态 | 仅做监控时可选 |

v1 只有 `movie.json`；未来会有 `book.json` / `tv.json` / `music.json` 等，**通过 manifest 发现**，consumer 无需硬编码品类列表。

---

## JSON 契约

### `manifest.json`

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-04-18T22:41:14.284Z",
  "categories": ["movie"],
  "urls": {
    "movie": "https://rank.douban.zhili.dev/movie.json"
  }
}
```

### `<category>.json`（例：`movie.json`）

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-04-18T22:41:14.284Z",
  "categories": {
    "movie": {
      "sources": {
        "imdb-top250": {
          "title": "IMDb Top 250",           // 英文榜单名
          "titleZh": "IMDb 250 佳片",         // 中文榜单名
          "url": "https://www.imdb.com/chart/top",  // 用户点击胶囊跳转的原榜单页
          "kind": "permanent",                // permanent | yearly | periodic
          "subCategory": "movie",             // 同 category 下细分（目前只 movie）
          "priority": 1,                      // UI 排序权重，小的靠前
          "updatedAt": "2026-04-18T22:40:51.561Z",
          "itemCount": 249
        }
        // ... 未来更多 source
      },
      "items": {
        "1292052": [
          { "source": "imdb-top250", "rank": 1 }
        ],
        "1291561": [
          { "source": "imdb-top250", "rank": 7 },
          { "source": "criterion", "rank": null, "spineNumber": "1056" }  // 未来示例
        ]
      }
    }
  }
}
```

### 字段语义

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 契约版本号。**consumer 在 mismatch 时必须静默降级**，不要报错 |
| `generatedAt` | 本次产出时间（ISO 8601 UTC） |
| `categories.<cat>.sources.<id>.kind` | `permanent`（永久殿堂榜）/ `yearly`（年度）/ `periodic`（周/月） |
| `categories.<cat>.sources.<id>.priority` | UI 多榜单显示时的排序权重，数字小的靠前（1 最高优先级） |
| `categories.<cat>.items[subjectId]` | **数组**，同一条目可能出现在多个榜单 |
| `items[].rank` | 榜单排名。`null` 表示"只收录不排名"（如 Criterion Collection） |
| `items[].spineNumber` | 可选辅助标识（如 Criterion 的 spine 编号） |

---

## 版本演进承诺

1. **字段只加不改**：新字段追加在后面，老字段永不改变语义
2. **`schemaVersion` 递增**当且仅当引入不兼容变更
3. **消费端 mismatch 时静默降级**（不显示标签），**不要 crash**
4. `items[subjectId]` 永远是数组（即便只有 1 条），consumer 代码无需区分单值/多值

---

## Userscript 消费实现

### 1. 声明网络权限

`.user.js` header 加一行：

```js
// @connect      rank.douban.zhili.dev
```

### 2. 主消费逻辑

```js
const DATA_URL = 'https://rank.douban.zhili.dev/movie.json';
const CACHE_KEY = 'rank_douban_movie';
const CACHE_TTL_MS = 24 * 3600 * 1000; // 24h

async function loadMovieRankings() {
  // 先读 GM 缓存
  const cached = GM_getValue(CACHE_KEY);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  // Cache miss / 过期 → 拉远端
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: DATA_URL,
      onload(res) {
        if (res.status !== 200) return resolve(null);
        try {
          const data = JSON.parse(res.responseText);
          if (data.schemaVersion !== 1) return resolve(null);  // 契约降级
          GM_setValue(CACHE_KEY, { ts: Date.now(), data });
          resolve(data);
        } catch (_) {
          resolve(null);
        }
      },
      onerror() { resolve(null); },
      ontimeout() { resolve(null); },
      timeout: 5000,
    });
  });
}

async function renderRankLabels() {
  const subjectMatch = location.pathname.match(/\/subject\/(\d+)/);
  if (!subjectMatch) return;
  const doubanId = subjectMatch[1];

  const data = await loadMovieRankings();
  if (!data) return;  // 网络失败 / 降级，静默

  const cat = data.categories?.movie;
  const entries = cat?.items?.[doubanId];
  if (!entries?.length) return;  // 此条目未上榜

  // 按 source.priority 升序排
  entries.sort((a, b) => {
    const pa = cat.sources[a.source]?.priority ?? 999;
    const pb = cat.sources[b.source]?.priority ?? 999;
    return pa - pb;
  });

  for (const entry of entries) {
    const meta = cat.sources[entry.source];
    if (!meta) continue;
    const text = entry.rank != null
      ? `${meta.titleZh} No.${entry.rank}`
      : meta.titleZh;
    insertRankLabel({
      text,
      href: meta.url,           // 用户点击跳原榜单
      sourceId: entry.source,   // 可用于 data-attribute 做样式变体
      kind: meta.kind,
    });
  }
}

renderRankLabels();
```

### 3. 视觉：复用豆瓣原生胶囊

豆瓣 `.rank-label-other` 的米色纹理胶囊样式，直接在新 DOM 节点上挂 class：

```js
function insertRankLabel({ text, href, sourceId, kind }) {
  const titleEl = document.querySelector('h1') || document.querySelector('#content h1');
  if (!titleEl) return;

  const container = titleEl.parentElement.querySelector('.rank-label-container')
    || (() => {
      const el = document.createElement('div');
      el.className = 'rank-label-container';
      titleEl.parentElement.insertBefore(el, titleEl);
      return el;
    })();

  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.className = 'rank-label-link rank-label-other';  // 复用豆瓣样式
  a.dataset.source = sourceId;
  a.dataset.kind = kind;
  a.textContent = text;
  container.appendChild(a);
}
```

---

## 缓存策略建议

- **TTL 24h** 够用：本 repo 数据每月更新一次（cron 每月第一个周日），consumer 比那更短刷新无意义
- **按 `schemaVersion` 命名 cache key**：`rank_douban_movie_v1`；未来 v2 不兼容时老 cache 自然过期
- **manifest.json 可以更短 TTL**（6-12h）以便早点发现新 category 上线
- **health.json 不用 cache**：consumer 一般不读它

---

## Graceful degradation

必须行为：

- 网络失败 / 超时 → **静默**，不影响 userscript 其他功能
- `schemaVersion` 不匹配 → **静默**，不 crash
- 某个 `source` 在 `sources` dict 里找不到（理论上不该发生）→ **跳过**，处理其他 entry
- `rank: null` → 显示只带榜单名，不显示 No.X
- `items[doubanId]` 不存在 → **不显示任何胶囊**，是正常情况（此条目真不在外部榜单）

---

## 当前 caveats（v1 阶段）

1. **只有 1 个 source**（`imdb-top250`）。consumer 代码应**遍历 `sources`**，不 hardcode source id。
2. **250 条里漏 1 条**：workflow 最新一次跑出 249/250（PRD §9.1 成功标准要求 ≥240）。个别条目在 movie.json 里不存在，属正常边界。
3. **更新频率月级**：如果你手工发现数据过期（比如 IMDb 新片上榜），可在本 repo Actions 里手动 `workflow_dispatch` 触发一次。
4. **schema 演进**：`book.json` / `tv.json` 等未来会加；userscript 通过 manifest 自动发现。

---

## 测试 checklist

集成完后验证：

- [ ] 打开《肖申克的救赎》<https://movie.douban.com/subject/1292052/>
  - 预期：title 上方出现 "IMDb 250 佳片 No.1" 胶囊，点击跳 `imdb.com/chart/top`
- [ ] 打开《教父》<https://movie.douban.com/subject/1291841/>
  - 预期：同上，排名不同
- [ ] 打开豆瓣一部未上 IMDb Top 250 的冷门片
  - 预期：**无**胶囊（静默）
- [ ] 断网情况下打开上述任一条目
  - 预期：页面正常，无胶囊，**userscript 其他评分聚合功能正常**
- [ ] Console 无未捕获异常

---

## 出问题排查

| 症状 | 可能原因 |
|---|---|
| 胶囊不显示但该片应在 IMDb Top 250 | (a) 249/250 中漏的那条；(b) cache 是旧数据，清 `GM_getValue` cache |
| CORS 报错 | manifest 没加 `@connect rank.douban.zhili.dev` |
| `schemaVersion` mismatch | 本 repo 发布了不兼容版本；consumer 需升级 |
| 胶囊排名和 IMDb 官网差几位 | 已知：本 repo 用 IMDb Datasets + 公开 weighted rating 公式近似，与 IMDb 真实 Top 250 有 < 10 条位置差异（见 `src/sources/imdb-top250.mjs` 注释） |

---

## 参考

- 本 repo 架构和 scope：`CLAUDE.md`
- 新增数据源（如果 consumer 想反向贡献）：`docs/adding-a-source.md`
- 产出 JSON 的 writer 实现：`src/writer.mjs`
