[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/DeanYang1204/makefun-git-forge-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/DeanYang1204/makefun-git-forge-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built for [make.fun's "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01) — $500 in USDC.

# makefun-git-forge

A standalone, single-process, GitHub-compatible git forge — the entry for the
make.fun `github-core-clone-01` bounty ("Build a GitHub-compatible git forge").

One Node 22 process, stdlib only, serves git smart HTTP, the REST v3 API,
GraphQL, and MCP over one shared in-memory store, and registers itself with
the trial env exactly as the bounty contract requires.

## What it serves

| Surface | Details |
| --- | --- |
| Git smart HTTP | `upload-pack` v2 (`ls-refs`, `fetch`, shallow/deepen, `filter`, `thin-pack`), `receive-pack` v0 (fast-forward only, `report-status`, `side-band-64k`, `delete-refs`), `# service` preamble, 404 for a missing repo |
| REST v3 (`/api/v3`) | repos (create/list/get/update/delete, contents, commits, branches, contributors), issues (create/list/get/update, labels, comments), pull requests (create/list/get/merge, squash merge with three-way conflict detection) |
| GraphQL (`/api/graphql`) | the suite's `gh` and `github-mcp-server` documents plus introspection; global ids are base64url of typed paths |
| MCP (`/mcp`) | modern 2026-07-28 (`server/discover`) and legacy `initialize` fallback; tools `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` |
| State export | deterministic JSON serialization of the whole store (no wall-clock time anywhere in state; server-made commits use a fixed epoch), so a live run and its replay export are byte-identical |

## Layout

- `main.ts` — entry point: lifecycle (bind ephemeral port → POST `/register` → long-poll `/done` → exit 0), from the kit starter, unchanged in shape.
- `app.ts` — HTTP router: auth, request-id header, dispatch to the four surfaces, export endpoint.
- `store.ts` — the shared store: repos, refs, objects, issues, pulls, labels, comments; id allocation, three-way merge/conflict, deterministic export.
- `gitproto.ts` — the git object model (loose objects, pack v2 read/write, pack idx v2, delta application for thin packs) and upload-pack fetch selection.
- `githttp.ts` — the smart-HTTP handlers (advertise, upload-pack v2, receive-pack v0).
- `rest.ts` — REST v3 handlers (exact status codes and error shapes: 401 unauth, 404 missing repo, 422 validation, 409 stale contents sha, 405 conflicted merge).
- `graphql.ts` — hand-rolled GraphQL parser/executor for the suite's documents.
- `mcp.ts` — MCP JSON-RPC handlers (unknown tool → -32602, missing arg → -32602, non-JSON body → HTTP 400 with -32700, no auth → 401).

## Run

```sh
# the trial env sets these; locally, a dummy env URL keeps the server up
MAKEFUN_ENV_URL=http://127.0.0.1:1 MAKEFUN_SHOP_TOKEN=test-token-123 \
  node --experimental-strip-types main.ts
```

Node 22 (erasable TypeScript only — no enums, namespaces, or parameter
properties, so the file runs under type stripping). No dependencies, no git
binary, no network beyond the suite.

## Scores (local, Node 24.22.1)

Full end-to-end trial against the kit's real env server
(`program/env/server.mjs`): **120/120 conformance, working 1, perf 166/200,
total 966/1000** — git 30/30, repos 15/15, issues 15/15, pulls 20/20,
protocol 5/5, GraphQL 20/20, MCP 15/15. Workload p50s vs the reference medians
in `sdk/conformance/calibration.json`: push 771 ms vs 1641 ms, clone 166 ms vs
267 ms, read 734 ms vs 2760 ms, write 123 ms vs 349 ms.

The kit's local runner (`sdk/run.ts --perf`) on three fresh servers scored
981, 977, and 982 (feature 600, agent 200, perf 166–182). The three practice
trials share the same scenario by construction (the suite's `buildScenario()`
is seed-fixed), so the repeat runs are the same trial re-measured.

## Notes for submission

- `.makefun/owner.json` is intentionally absent — it is added at submit time.
- No timestamps, ports, or random ids enter exported state; request ids are
  per-process counters (`req-N`) and are not part of state.
