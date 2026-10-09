# zotero-harness-bridge

**A zero-dependency MCP server that puts your local Zotero library in front of
DeepSeek Harness (DSH) - and of any other MCP client.**

[![CI](https://github.com/JARRY-DJH/zotero-harness-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/JARRY-DJH/zotero-harness-bridge/actions/workflows/ci.yml)
![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)
![runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen.svg)

Once registered, the model can search your library, read item metadata, walk
collections and tags, read the indexed full text of your PDFs and export
citations as BibTeX - all through ordinary tool calls such as
`mcp__zotero__search_items`.

## Why this exists

Most Zotero MCP servers are Python packages that need `pip install` and an
outbound network connection. This one is a small Node program that imports
nothing but Node's own standard library:

- **No dependencies.** No `npm install`, no `pip`, no build step, no lockfile.
- **No machine-specific paths.** Every path and URL is detected at run time or
  supplied through an environment variable, so the same checkout works on any
  computer.
- **Read-only.** It never writes to your library, downloads attachments or
  deletes anything.
- **Works offline.** The only host it contacts is the one you configure -
  your own Zotero, by default.

## Requirements

| Component | Version |
|---|---|
| Node.js | 18 or newer (uses the built-in `fetch`) |
| Zotero | 7.x desktop, running, with the local API enabled |
| DeepSeek Harness | any recent build; the bundled `@deepseek-ai/dsh-mcp-client` is enough |

## Quick start

### 1. Turn on Zotero's local API

In Zotero open **Edit > Settings > Advanced** and tick

> Allow other applications on this computer to communicate with Zotero

Zotero has to stay running: its local API only exists while the app is open.

### 2. Get the code and check the connection

```bash
git clone https://github.com/JARRY-DJH/zotero-harness-bridge.git
cd zotero-harness-bridge
node src/server.mjs --check
```

There is nothing to install. A healthy setup reports:

```
Zotero bridge self-check
  server            zotero-harness-bridge 0.1.0
  node              v22.x.x (/usr/local/bin/node)
  platform          linux x64
  apiBase           http://127.0.0.1:23119/api/users/0
  apiKeyConfigured  false
  timeoutMs         30000
  connected         yes
  sampleSize        1
```

If it says `connected NO`, the message explains which of the three usual
causes applies.

### 3. Register the server with DSH

```bash
node scripts/setup.mjs --dsh
```

That command detects where `node` lives on your machine and where
`src/server.mjs` lives, then prints a finished patch block. Append it to the
patch layer of the DSH profile you use:

| Operating system | File |
|---|---|
| Windows | `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml` |
| macOS / Linux | `~/.dsh/profiles/<profile>/cordis.patch.yml` |

If you prefer to start from a template, `examples/dsh/cordis.patch.yml` is the
same block with `<NODE_EXECUTABLE>` and `<SERVER_ENTRY>` placeholders.

Restart DSH. The tools now appear to the model as `mcp__zotero__*`.

### 4. Ask

> What is in my Zotero library?

## Verify it without a client

The server speaks newline-delimited JSON-RPC 2.0 over stdio, so you can drive
it by hand:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node src/server.mjs
```

Two JSON-RPC responses come back on stdout; diagnostics go to stderr.

## Configuration

Every setting is an environment variable with a portable default. DSH
sanitises the environment of the processes it spawns, so the values you need
must appear in the `env:` block of the client configuration - they are not
inherited from your shell.

| Variable | Default | Purpose |
|---|---|---|
| `ZOTERO_API_BASE` | `http://127.0.0.1:23119/api/users/0` | Full API base URL. Point it at the Web API (`https://api.zotero.org/users/<id>`) or a group library when needed. |
| `ZOTERO_LOCAL_HOST` | `127.0.0.1` | Host used when `ZOTERO_API_BASE` is unset. |
| `ZOTERO_LOCAL_PORT` | `23119` | Port used when `ZOTERO_API_BASE` is unset. |
| `ZOTERO_LIBRARY_TYPE` | `user` | `user` or `group`. |
| `ZOTERO_LIBRARY_ID` | `0` | Library id. The local API only serves `0` ("My Library"). |
| `ZOTERO_API_KEY` | *(empty)* | Zotero Web API key. Never needed for the local API, and never logged. |
| `ZOTERO_TIMEOUT_MS` | `30000` | Per-request timeout in milliseconds. |
| `ZOTERO_MCP_PROTOCOL` | `2025-11-25` | MCP revision the server answers with. |

## Tools

| Tool | What it does |
|---|---|
| `zotero_status` | Connection self-check: API base, key presence, readability. |
| `zotero_search_items` | Search by keyword, item type, tag or collection; `qmode=everything` also searches full text. |
| `zotero_get_item` | Complete metadata for one item key. |
| `zotero_get_item_children` | Attachments and notes of an item - this is how the PDF is found. |
| `zotero_get_fulltext` | Indexed full text of an attachment, with `offset` / `maxChars` paging. |
| `zotero_list_collections` | Every collection with its key and item count. |
| `zotero_get_collection_items` | The items inside a collection. |
| `zotero_list_tags` | Tags and how many items carry each one. |
| `zotero_get_recent_items` | Most recently added items, newest first. |
| `zotero_get_bibtex` | BibTeX or CSL-JSON for one or more item keys. |

Two MCP resources are exposed as well:

- `zotero://library/recent-items`
- `zotero://collection/<collectionKey>`

## Command line

| Command | Purpose |
|---|---|
| `node src/server.mjs` | Run the MCP server on stdio - this is what clients spawn. |
| `node src/server.mjs --check` | Probe Zotero, print a report; exit code 0 when reachable, 1 otherwise. |
| `node src/server.mjs --check --json` | The same report as JSON. |
| `node src/server.mjs --print-config` | Print an `mcpServers` JSON block built from this machine's real paths. |
| `node src/server.mjs --help` | Usage and the environment reference. |
| `node scripts/setup.mjs` | Full report: detected paths, DSH block, generic block. |
| `node scripts/setup.mjs --dsh` | Only the `cordis.patch.yml` block. |
| `node scripts/setup.mjs --json` | Machine-readable report (useful for installers). |
| `node scripts/setup.mjs --out <file>` | Write the DSH block to a file. |
| `npm test` | Run the offline test suite. It needs no Zotero and no network. |

The package also declares a `bin` entry, so after
`npm install -g zotero-harness-bridge` the shorter `zotero-harness-bridge` works too.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `connected NO` with `ECONNREFUSED` | Zotero is closed, or the checkbox in step 1 is off. |
| No `mcp__zotero__*` tools appear at all | The patch block is not valid YAML, or DSH was not restarted. Look for an `mcp-client` error in the DSH log. |
| `fetch failed` although Zotero is running | Zotero's `extensions.zotero.httpServer.port` was changed; set `ZOTERO_LOCAL_PORT` to match. |
| `zotero_get_fulltext` returns nothing | Zotero has not indexed that PDF. Open it once in Zotero and retry. |
| Large-library calls time out | Raise `ZOTERO_TIMEOUT_MS` and `toolCallTimeoutMs` in the DSH entry. |
| A tool returns `isError` instead of data | That is by design: tool failures never take the harness down with them. |

More detail, including local-API versus Web-API differences, is in
[docs/limitations.md](docs/limitations.md).

## Project layout

```
src/server.mjs      the MCP server: stdio transport, JSON-RPC dispatch, tools
src/config.mjs      side-effect-free defaults shared by the server and setup
scripts/setup.mjs   renders client configuration for this machine
examples/           placeholder-based client snippets
docs/               limitations and design notes
test/               mock Zotero API + the offline node:test suite
```

## Development

There is no build step and nothing to install:

```bash
npm test                        # the whole suite, no Zotero required
node src/server.mjs --check     # smoke test against a live Zotero
node src/server.mjs --help      # the full environment reference
node scripts/setup.mjs          # smoke test of the config generator
```

The suite starts `test/mock-zotero.mjs` - a small stand-in for the Zotero local
API - points the bridge at it, and drives the real server process over its real
stdio transport. It covers all ten tools, resource listing and reading, the
JSON-RPC error paths, every CLI mode, the configuration defaults, and a few
hygiene rules (no runtime dependencies, no committed scratch files, nothing
machine specific).

CI runs it on Linux, Windows and macOS across Node 20, 22 and 24, plus one
extra run on Node 18 so the `engines` floor in `package.json` stays honest.
See [CONTRIBUTING.md](CONTRIBUTING.md) for the ground rules.

## Licence

[MIT](LICENSE).
