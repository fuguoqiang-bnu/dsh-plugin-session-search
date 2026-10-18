# dsh-session-explorer

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns **every conversation stored on this machine** into one searchable, always-current panel.

Search all history by keyword — Chinese substrings included — with highlighted hits, and see the shape of your work at a glance: a 14-day activity chart, tool-call ranking, and a per-workspace breakdown. Everything is computed locally; nothing leaves the machine.

> 中文说明见 [README.zh.md](README.zh.md)。

## What you get

- **Keyword search over all sessions.** Multiple space-separated terms are ANDed; wrap a phrase in `"quotes"` to keep it together. Matching is case-insensitive and works on raw substrings, so `魔法链接` or `pnpm test` hit inside a sentence — no tokenizer, no FTS backend required.
- **Highlighted hits.** Every result carries the exact `[start, end)` ranges to highlight, so the UI marks the words without re-scanning text.
- **Visualization.** Sessions / indexable messages / total characters / workspaces as stat cards; a 14-day stacked bar chart; top-10 tool calls; workspace distribution.
- **Live.** The panel polls a host-side index that is rebuilt incrementally: a session is re-read only when its log length (live) or persistence revision (cold) changed. A conversation you are having right now becomes searchable within a couple of seconds.
- **Drill-down.** Open any hit to read the whole conversation in a drawer, then jump to it in DSH with one button.

## Install

The plugin is a normal DSH bundle: a package whose `package.json` declares `dsh.bundle.patch`.

**With the plugin manager** (recommended):

```text
plugin_manager  action: install_bundle  target: <absolute path to this checkout>
```

or install straight from GitHub:

```text
dsh plugin add github:<you>/dsh-session-explorer
```

**By hand**: copy this directory into `$DSH_PROFILE_DIR/node_modules/dsh-session-explorer`, add `"dsh-session-explorer"` to `dsh.profile.bundles` in the profile `package.json`, and restart DSH. The bundle's `cordis.patch.yml` inserts the plugin row.

After installation, open the left sidebar and click **会话检索 / Session Explorer** (a magnifier-with-bars glyph).

## How it works

```text
┌──────────────── browser (lib/client.js) ─────────────────┐
│ main panel  +  sidebar.panellist icon                    │
│ polls GET /api/session-explorer/state?q=…                │
└───────────────────────────┬──────────────────────────────┘
                            │ same-origin fetch (JSON)
┌───────────────────────────┴──────────────────────────────┐
│ host (lib/index.js)                                      │
│  • ctx.sessionQuery.listSessions() / readSession()       │
│  • semantic-text extraction per event (mirrors DSH)      │
│  • incremental in-memory index + literal keyword search  │
│  • ctx.webServer.register({ kind: 'prefix', … })         │
└──────────────────────────────────────────────────────────┘
```

Two deliberate choices:

1. **Reads, not FTS.** `dsh-base` ships `dsh-session-query-sqlite` with `openAt: never`, so ranked full-text search is off by default. This plugin uses only the exact reads every deployment provides (`listSessions`, `readSession`) and maintains its own derived index. Substring recall — especially for CJK, where the `unicode61` tokenizer cannot match inside a token — is exactly what a keyword box should do.
2. **An HTTP route, not generated RPC.** DSH's Typert Remote channel needs generated descriptors and codecs. A plain-JS plugin can instead register a route on `ctx.webServer` (same origin, same port, no extra listener) and `fetch` it. That keeps this package dependency-free and installable anywhere.

### HTTP surface

| Method | Path | Meaning |
|---|---|---|
| `GET` | `/api/session-explorer/state?q=` | Index status, stats, session summaries, and hits for `q` |
| `GET` | `/api/session-explorer/session?id=` | Readable body of one session (last 400 events) |
| `POST` | `/api/session-explorer/refresh` | Force a full re-index |
| `GET` | `/api/session-explorer/health` | Liveness probe |

All responses are JSON with `cache-control: no-store`.

## Privacy

- Everything is read from the local DSH session store and kept in the host process's memory.
- No network calls, no telemetry, no files written outside DSH's own session store.
- The route is registered on the same server that serves your Web GUI, so it is reachable only where that GUI is reachable.

## Compatibility

- Requires the `webServer` service (the Web GUI deployment). Headless/CLI profiles without it will not load the plugin.
- Requires `ctx.sessionQuery` (shipped in `dsh-base`). If a deployment removes it, the panel shows the reason instead of failing.
- Node `^22.19.0 || >=24.0.0`, matching DSH's own engines.
- Verified against DSH `0.2.1-rc.2` desktop profile.

## Development

```bash
node test/smoke.mjs
```

The smoke test mounts the plugin into a fake Cordis context, drives the real HTTP handler, and checks extraction, search semantics (CJK substring, case-insensitivity, multi-term AND, highlight ranges), the detail endpoint, incremental re-indexing, and teardown.

There is no build step: `lib/index.js` and `lib/client.js` are plain ESM / browser-module JavaScript.

## License

MIT — see [LICENSE](LICENSE).
