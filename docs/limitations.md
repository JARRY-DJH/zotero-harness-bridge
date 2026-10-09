# Limitations and design notes

This page collects everything the bridge deliberately does not do, so that
expectations are set before you wire it into a client.

## Zotero must be running

The default transport is Zotero 7's **local HTTP API**, which only exists while
the Zotero desktop application is running without
`extensions.zotero.httpServer.enabled` disabled. When Zotero is closed,
`zotero_status` reports a connection error and the other tools fail the same way.
The MCP server process itself always starts, so the harness boots normally.

## Read-only

Every tool is a read. The bridge never writes to your library, never creates or
deletes items, and never downloads attachments. Attachment *text* is read only
from the index Zotero already built.

## Full text needs Zotero's index

`zotero_get_fulltext` returns the content of Zotero's full-text index for an
attachment. A PDF that has never been opened in Zotero, or one that is a scanned
image without OCR, will come back empty. Open the PDF once in Zotero and retry.

## The local API port is configurable

23119 is only the default. If you changed
`extensions.zotero.httpServer.port` in Zotero's advanced configuration, set
`ZOTERO_LOCAL_PORT` (or the full `ZOTERO_API_BASE`) to match. The bridge never
guesses a port by scanning.

## Local API versus Web API

* The local API needs no account and no key, but only serves **your own**
  library (`users/0`). Group libraries are not reachable through it.
* The Web API (`https://api.zotero.org/users/<id>`) needs `ZOTERO_API_KEY` and a
  working outbound HTTPS connection.
* Zotero's **local** API implements a subset of the Web API. Endpoints that do
  not exist locally are reported verbatim as an HTTP error rather than being
  silently emulated.

## Citation export on the local API

The local API honours `?format=bibtex` / `?format=csljson` only on the
**single-item** endpoint, and its `?itemKey=` collection filter also matches child
attachments (which would yield a citation for the PDF instead of the article).
The bridge therefore exports one key at a time, and if an endpoint implements no
exporter at all it falls back to a locally generated BibTeX entry built from the
item's metadata. Fallback entries carry fewer fields than Zotero's own export.

## Protocol revision

The server answers with MCP revision `2025-11-25`, the classic wire shape that
DSH's bundled `@deepseek-ai/dsh-mcp-client` (and most current clients) model. Set
`ZOTERO_MCP_PROTOCOL` if a future client demands another revision.

## Environment passing

DSH sanitises the environment it hands to spawned MCP servers. Every variable
listed in the README has to appear in the `env:` block of the client
configuration; inheriting them from your shell will not work.

## Output size

Tool results are truncated at 60 000 characters. `zotero_get_fulltext` supports
`offset` / `maxChars` so long documents can be paged through instead of
being cut off.

## Language

The strings this server exposes to the model (tool names, descriptions and the
`instructions` field) are English. Item titles, collection names and full text
are returned exactly as they are stored in your library, so non-English
libraries work unchanged.
