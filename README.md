# douban-rankings

爬取多个外部电影/剧/书/音乐等榜单，建立 **"豆瓣 subject ID → 所在榜单与排名"** 的反向索引，以静态 JSON 发布在 <https://rank.douban.zhili.dev>。

供姐妹项目 `douban-rating-hub` userscript 消费，在豆瓣条目页上显示外部权威榜单标签（IMDb Top 250、Criterion Collection 等）。

**本仓库不含 UI**。

## 数据访问

```
https://rank.douban.zhili.dev/manifest.json     可用 categories 列表
https://rank.douban.zhili.dev/movie.json        电影反向索引
https://rank.douban.zhili.dev/health.json       最近一次抓取的健康状态
```

`movie.json` 结构片段：

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-04-18T04:10:00Z",
  "categories": {
    "movie": {
      "sources": {
        "imdb-top250": { "title": "IMDb Top 250", "kind": "permanent", "priority": 1, "itemCount": 250 }
      },
      "items": {
        "1292052": [{ "source": "imdb-top250", "rank": 1 }]
      }
    }
  }
}
```

契约要点：

- `schemaVersion` 在消费侧不匹配时**静默降级**，不要报错
- 字段**只加不改**——新字段追加，老字段语义不变
- `items[subjectId]` 是数组，同一条目可在多榜单

## 开发

- Node 20+，ESM，pnpm（通过 `corepack enable`）
- `pnpm install`
- `pnpm run update` — 跑 pipeline，刷新 `data/*.json`
- `pnpm test` — 单测
- `pnpm run health` — 查看健康状态

单文件跑测试：`node --test test/<path>/<file>.test.mjs`

## Scope

只收录**豆瓣自己未展示**的外部权威榜单。豆瓣条目页 `<ul class="award">` 已覆盖的奖项（奥斯卡 / 金球 / BAFTA / 戛纳等）、豆瓣官方 Top 250 与 `subject_collection` 不重复收录。本项目是 complement，不是 replacement。

## 致谢

- **[PtGen archive](https://ourbits.github.io/PtGen/)** — 约 40 万条 IMDB ↔ 豆瓣 subject id 映射，由 R酱 Rhilip 等 OurBits 社区维护，是 matcher 主要数据源
- **[rank4douban](https://github.com/eddiehe99/rank4douban)** — 三层 matcher 策略（manual → community map → search）思路来源
- 仅用于学习目的；数据版权归各自权利人所有

## License

MIT — see [LICENSE](LICENSE)。
