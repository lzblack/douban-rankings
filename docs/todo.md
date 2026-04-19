# TODO

Open work items that aren't blocking v1 but worth tracking.

## Triage against `bimzcy/rank4douban` CSV

Validator `scripts/_local/validate-criterion.mjs` produces three lists; tackle
these when Criterion coverage becomes a user-visible pain point:

1. **40 disagreements** — our auto-resolve differs from bimzcy's hand-curated
   dbid. Value: exposes potential matcher bugs. Each case needs human decision
   on whose dbid is "correct" (legacy vs. restoration preference).
2. **156 unresolved-but-bimzcy-has** — the main coverage-expansion list.
   Triage rule: paste single films only, skip box-sets (bimzcy maps a set to
   one representative film, which is their editorial call, not necessarily
   ours). Each candidate must be verified by opening
   `https://movie.douban.com/subject/<dbid>/` in browser.
3. **1 bimzcy-only spine** — their snapshot lists a spine we don't. Low
   priority; could indicate CC catalog difference.

**Boundary (PRD §1.3)**: use validator output as *triage hints*, not a
wholesale import. Each mapping-file entry is our own curation decision
after visual verification — bimzcy's CSV stays out of the repo.

## Bangumi Top 250 retry

First fetch (`pnpm run fetch:bangumi-top250-snapshot`) resolved only
13/250 anime via `search.douban.com` before Douban's anti-scrape
kicked in. Remaining 237 return "搜索访问太频繁".

Re-run the fetcher after the rate-limit resets (typically ≥24 h, or
after using Douban normally in a browser for a bit). Script has
resume support: already-resolved dbids are reused, only the 237
unresolved entries will re-query.

Command: `node scripts/fetch-bangumi-top250-snapshot.mjs`

Repeat until `resolvedCount` approaches 250. Could take multiple
sessions across several days to avoid re-tripping the limit.

## Consumer feedback backlog

When `douban-rating-hub` users report "opened film X, expected a label, got
none":

- Check if the film is in a source's unresolved log (pipeline stderr)
- If yes: verify the dbid, add to `config/manual-mapping.yaml`
- If no: the film genuinely isn't on any list we publish — close as "out of
  scope" or consider adding a new source

## Future sources (v2+ candidates)

Loose candidates in priority order; revisit once v1 has been in production a
bit and we have data on actual gaps:

- **BFI Sight & Sound 2022 Critics Top 100** — decadal critics poll, 100
  entries, stable Wikipedia list. Good "next source" candidate.
- **Letterboxd Official Top 250** — `letterboxd.com/official/top-of-the-week/`
  has film links with tt ids; active list.
- **AFI 100 Years... 100 Movies (2007)** — American canon, 100 entries.
- **TSPDT 1000** — art-film authority, large (1000 entries); lower priority.
- **Bangumi Top 250** — anime; requires new category (`anime` or `tv`).
