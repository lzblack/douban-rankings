# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本文件面向任何在本仓库启动的 Claude Code session。Zhi 的全局 `~/.claude/CLAUDE.md` 已定义工程原则（TDD、root cause、scope 控制等），本文件只补项目特有的信息，不重复全局规则。

## 项目使命

`douban-rankings` 是纯数据 scraper：爬取多个外部电影/剧/书/音乐等榜单，建立 **"豆瓣 subject ID → 所在榜单与排名"** 的反向索引，以静态 JSON 发布在 `https://rank.douban.zhili.dev`（Cloudflare Pages），供姐妹项目 `lzblack/userscripts/douban-rating-hub.user.js` 消费。

**本 repo 不做 UI**。渲染在 userscript 侧，JSON 契约是两侧唯一接口。

## Governing Docs

- `docs/2026-04-18-douban-rankings-prd.md`（若仍在本地）—— PRD v1.0，含完整 JSON schema、限速策略、Actions 配置、v1 交付范围、开发顺序。新 session 开工前若能读到此文件，**优先读**；与本 CLAUDE.md 冲突时 PRD 优先（scope / 需求层面）。
- 该 PRD 可能从 public repo 移除（只保留在 Zhi 本地），本 CLAUDE.md 保持自洽，不得因 PRD 缺失而阻塞。

## 当前状态

截至首次 commit，仓库只有 `README.md` / `LICENSE` / `.gitignore` / `docs/`。**代码、`package.json`、`src/`、`test/`、`config/`、`data/`、Actions workflow 均未实现**。pre-bootstrap 阶段。

## Scope 红线（绝对不做）

- ❌ 任何 UI 或用户交互
- ❌ 爬豆瓣自己的榜单（Top 250 / `subject_collection` 等豆瓣自己已展示的内容）
- ❌ 重复爬豆瓣条目页 `<ul class="award">` 已覆盖的奖项（奥斯卡 / 金球 / BAFTA / 戛纳等）
- ❌ v1 范围外品类：书 / 音乐 / 剧 / 舞台剧 / 游戏 / 播客（v2+）
- ❌ 实时 API、自托管部署

**加任何新 source 前先问：豆瓣自己是否已展示？答案是 Yes 就停手。** 本项目是 complement，不是 replacement。

## 技术栈约束

- Node 20+，ESM（`"type": "module"`）
- pnpm（`corepack enable`），锁文件提交
- **Runtime 依赖白名单**：`cheerio`、`yaml`。加依赖前说明理由
- 测试框架：Node 20 内置 `node --test`，**不**引入 jest / vitest
- 类型：JS + JSDoc，**不**用 TS（避免 tsc build step）
- 代码风格：prettier 默认 + 4 空格缩进

## 常用命令（按规划，尚未实现）

| 命令 | 用途 |
|---|---|
| `pnpm install --frozen-lockfile` | 装依赖 |
| `pnpm run update` | 跑 pipeline，产出 `data/*.json` |
| `pnpm test` | `node --test test/**/*.test.mjs` |
| `pnpm run health` | 产出/检查 `data/health.json` |
| `pnpm run format` | prettier 格式化 `src/**/*.mjs` |

**单文件跑测试**：`node --test test/path/to/file.test.mjs`

## 核心架构

```
src/sources/<id>.mjs          每个外部榜单一个模块：scrape(http) → 原始条目
      ↓
src/matchers/                 外部 ID 反查豆瓣 subject id
  imdb-to-douban.mjs          首选：GET movie.douban.com/imdb/{ttID}/ 取 302 Location
  title-year-to-douban.mjs    兜底：标题 + 年份 搜豆瓣（谨慎用，限速更保守）
      ↓
src/pipeline.mjs              编排 source → matcher → aggregator
      ↓
src/writer.mjs                产出 data/<category>.json + manifest.json
src/health.mjs                产出 data/health.json + 失败 ≥ 3 次开 GH issue
src/util/http.mjs             所有 fetch 的唯一出口：UA、限速、重试、指数退避
```

**Per-source isolation**：单个 source 失败不中断整个 pipeline，错误聚到 `health.json`。

**所有网络请求必须走 `src/util/http.mjs`**。禁止 source / matcher 直接用原生 `fetch`——限速与反爬集中在 http client 里维护，分散调用会让限速策略失效。

## 反爬关键约束

| 目标 | 限速 | 失败策略 |
|---|---|---|
| 豆瓣 `/imdb/` redirect | **1 req / 5s** | 连续 403/429 × 5 次 → 停掉整个 run + 健康告警 |
| 外部榜单页（IMDb / Criterion 等） | 1 req / 2s | 429/5xx 指数退避 5s→30s→60s 后停 |
| `douban.com/search` 兜底 | 1 req / 8-10s | 严格保守，优先走 `config/manual-mapping.yaml` |
| 单 URL 重试 | 最多 2 次 | — |

`config/manual-mapping.yaml` 是人工兜底表，反查失败的 IMDB ID / 标题人工填入，比扩大自动搜索风险低得多。

## 产出与发布

- 产出目录：`data/`
- 托管：**Cloudflare Pages**，build output directory = `data`，push 到 `main` 自动 deploy
- 自定义域名 `rank.douban.zhili.dev` 绑定在 CF Pages 项目设置里——**repo 里无 CNAME 文件**（CF Pages 不看）
- 选 CF Pages 而非 GitHub Pages 的主因是**国内访问稳定性**（GH Pages 边缘 IP 国内抽风）；次因是保留 `data/` 目录且 URL 干净
- 对外 URL：
  - `https://rank.douban.zhili.dev/manifest.json`
  - `https://rank.douban.zhili.dev/movie.json`（v1 只 movie）
  - `https://rank.douban.zhili.dev/health.json`

## Timeline 策略

**git 本身即快照存储**：每次 workflow 跑完，`data/` 有变化就自动 commit 到 `main`。

Commit message 规范：`data(<category>): <sourceId> updated — N items (+a -b)`
Bot 身份：`rankings-bot <bot@users.noreply.github.com>`，与人类作者区分。

`git log --follow data/movie.json` 即历史查询入口，无需额外 snapshot 目录。

## JSON 契约稳定性

- `schemaVersion` 字段存在，消费方在 version mismatch 时**静默降级**，不报错
- 字段**只加不改**：新字段加在后面，老字段不改语义
- 改契约前评估对 `douban-rating-hub` userscript 的影响

## Git / PR 约定

- 默认直推 `main`（小步原子 commit）；只在 Zhi 明确要求时开 feature branch
- PR 合并前跑通 `pnpm test` 和至少一次本地 `pnpm run update` 样本验证

## 公共 repo 提醒

- public + MIT：任何 commit / issue / PR 公开可见，注意不要把调试日志、个人路径、非公开链接留在 commit 里
- v1 **零 API key**；v2+ 引入 key 时必须走 `${{ secrets.* }}`，代码用 `process.env.*` 读；`writer` 层加 sanity check 确保产出 JSON 不含任何 key 字样
- Fork PR 默认拿不到 secrets（GitHub 安全默认），不要依赖此行为做设计

## 姐妹项目

- **消费方**：`lzblack/userscripts/douban-rating-hub.user.js`（油猴脚本，聚合多平台评分并显示榜单标签）
- **视觉参考**：豆瓣原生 `.rank-label-other` 样式（米色纹理胶囊），UI 完全在 userscript 侧
