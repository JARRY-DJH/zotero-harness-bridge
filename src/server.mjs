#!/usr/bin/env node
/*
 * zotero-harness-bridge - dependency-free Model Context Protocol (MCP) server
 * that exposes a local Zotero library to DeepSeek Harness (DSH) and to any
 * other MCP client.
 *
 * Transport : stdio, newline-delimited JSON-RPC 2.0 (MCP stdio transport)
 * Requires  : Node.js >= 18 (uses the global fetch). No npm dependencies.
 * Talks to  : the Zotero local HTTP API (default) or the Zotero Web API.
 *
 * Nothing here is machine specific: every path and URL is supplied by the MCP
 * client (see examples/) or by the environment variables below, and every one
 * of them has a portable default.
 *
 * Environment variables (all optional):
 *   ZOTERO_API_BASE     full API base URL, e.g.
 *                       http://127.0.0.1:23119/api/users/0        (local API, default)
 *                       https://api.zotero.org/users/<userID>     (Web API)
 *                       https://api.zotero.org/groups/<groupID>   (group library)
 *   ZOTERO_LOCAL_HOST   host used when ZOTERO_API_BASE is unset  (default 127.0.0.1)
 *   ZOTERO_LOCAL_PORT   port used when ZOTERO_API_BASE is unset  (default 23119)
 *   ZOTERO_LIBRARY_TYPE user | group                              (default user)
 *   ZOTERO_LIBRARY_ID   library id; 0 = "my library" locally     (default 0)
 *   ZOTERO_API_KEY      optional; sent as the Zotero-API-Key header
 *   ZOTERO_TIMEOUT_MS   per-request timeout in ms                 (default 30000)
 *   ZOTERO_MCP_PROTOCOL MCP protocol revision to answer with
 *
 * Run `zotero-harness-bridge --help` for the CLI (self-check, config printer).
 * stdout is reserved for protocol messages. All logging goes to stderr.
 */
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  SERVER_NAME,
  readVersion,
  resolveApiBase,
  resolveApiKey,
  resolveTimeoutMs,
  stdioServerConfig,
} from "./config.mjs";

const SERVER_VERSION = readVersion();
// DSH's MCP client models exactly two wire revisions: the legacy
// "2025-11-25" and the modern "2026-07-28". We always answer with the frozen
// legacy revision, whose wire shape is the classic MCP one this server emits.
// Override with ZOTERO_MCP_PROTOCOL if a future client requires otherwise.
const PROTOCOL_VERSION = process.env.ZOTERO_MCP_PROTOCOL || "2025-11-25";
const MAX_TEXT_CHARS = 60000;

function log(level, message) {
  try {
    process.stderr.write("[" + SERVER_NAME + "] " + level + ": " + message + "\n");
  } catch (err) {
    /* never let logging break the server */
  }
}

function rpcError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/* ------------------------------------------------------------------ config */

const CONFIG = {
  apiBase: resolveApiBase(),
  apiKey: resolveApiKey(),
  timeoutMs: resolveTimeoutMs(),
};

function connectionHint() {
  return "Check that (1) the Zotero desktop app is running; (2) \"Allow other applications on this computer to communicate with Zotero\" is enabled under Edit > Settings > Advanced;"
    + " (3) the configured API base " + CONFIG.apiBase + " is correct.";
}

/* ------------------------------------------------------------- zotero HTTP */

async function zoteroFetch(path, params, accept) {
  let url;
  try {
    url = new URL(CONFIG.apiBase + path);
  } catch (err) {
    throw new Error("ZOTERO_API_BASE is not a valid URL: " + CONFIG.apiBase);
  }
  if (params) {
    for (const entry of Object.entries(params)) {
      const key = entry[0];
      const value = entry[1];
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.set(key, String(value));
    }
  }
  const headers = {
    "Zotero-API-Version": "3",
    "Accept": accept || "application/json",
  };
  if (CONFIG.apiKey) headers["Zotero-API-Key"] = CONFIG.apiKey;

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, CONFIG.timeoutMs);
  let response;
  try {
    response = await fetch(url, { headers: headers, signal: controller.signal });
  } catch (err) {
    const cause = err && err.cause ? (err.cause.code || err.cause.message || "") : "";
    if (err && err.name === "AbortError") {
      throw new Error("Request timed out after " + CONFIG.timeoutMs + " ms: " + url.href);
    }
    throw new Error("Cannot reach Zotero: " + (err && err.message ? err.message : String(err))
      + (cause ? " (" + cause + ")" : "") + ". " + connectionHint());
  } finally {
    clearTimeout(timer);
  }

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error("Zotero API returned " + response.status + " " + response.statusText
      + " [" + url.pathname + "]: " + bodyText.slice(0, 500));
  }
  if (accept && accept.indexOf("json") === -1) return bodyText;
  if (!bodyText) return null;
  try {
    return JSON.parse(bodyText);
  } catch (err) {
    return bodyText;
  }
}

/* ------------------------------------------------------------ formatting */

function yearOf(item) {
  const data = (item && item.data) || {};
  const match = /([12][0-9]{3})/.exec(String(data.date || ""));
  return match ? match[1] : "";
}

function creatorList(data) {
  const creators = (data && data.creators) || [];
  const names = [];
  for (const creator of creators) {
    if (!creator) continue;
    if (creator.name) { names.push(creator.name); continue; }
    const parts = [creator.lastName, creator.firstName].filter(Boolean);
    if (parts.length) names.push(parts.join(", "));
  }
  return names;
}

function formatItem(item, index) {
  const data = (item && item.data) || {};
  const title = data.title || data.name || "(untitled)";
  const authors = creatorList(data);
  let authorText = "";
  if (authors.length === 1) authorText = authors[0];
  else if (authors.length > 1 && authors.length <= 3) authorText = authors.join("; ");
  else if (authors.length > 3) authorText = authors.slice(0, 3).join("; ") + " et al. (" + authors.length + " authors)";

  const meta = [];
  if (authorText) meta.push(authorText);
  if (yearOf(item)) meta.push(yearOf(item));
  const container = data.publicationTitle || data.proceedingsTitle || data.bookTitle
    || data.encyclopediaTitle || data.publisher || data.university || data.institution || "";
  if (container) meta.push(container);
  if (data.DOI) meta.push("DOI:" + data.DOI);

  const lines = [];
  lines.push((index === undefined ? "" : String(index + 1) + ". ") + title);
  if (meta.length) lines.push("   " + meta.join(" · "));
  lines.push("   key=" + (data.key || item.key || "?") + "  type=" + (data.itemType || "?")
    + (data.numChildren ? "  children=" + data.numChildren : ""));
  return lines.join("\n");
}

function renderItems(items, format) {
  if (format === "json") return JSON.stringify(items, null, 2);
  if (!Array.isArray(items) || items.length === 0) return "No matching items.";
  return items.map(function (item, index) { return formatItem(item, index); }).join("\n\n");
}

function renderCollections(collections, format) {
  if (format === "json") return JSON.stringify(collections, null, 2);
  if (!Array.isArray(collections) || collections.length === 0) return "The library has no collections.";
  return collections.map(function (collection, index) {
    const data = (collection && collection.data) || {};
    return String(index + 1) + ". " + (data.name || "(unnamed collection)")
      + "\n   key=" + (data.key || collection.key || "?")
      + "  items=" + (data.numItems === undefined ? "?" : data.numItems);
  }).join("\n\n");
}

function renderTags(tags, format) {
  if (format === "json") return JSON.stringify(tags, null, 2);
  if (!Array.isArray(tags) || tags.length === 0) return "No tags.";
  return tags.map(function (tag) {
    const meta = tag.meta || {};
    return "- " + (tag.tag || "?") + (meta.numItems === undefined ? "" : " (" + meta.numItems + ")");
  }).join("\n");
}

function text(value, isError) {
  let body = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (body.length > MAX_TEXT_CHARS) body = body.slice(0, MAX_TEXT_CHARS) + "\n\n… (output truncated)";
  return { content: [{ type: "text", text: body }], isError: isError === true };
}

/* -------------------------------------------------- BibTeX fallback path */

function bibtexType(itemType) {
  const map = {
    journalArticle: "article", conferencePaper: "inproceedings", book: "book",
    bookSection: "incollection", thesis: "phdthesis", report: "techreport",
    webpage: "misc", document: "misc", manuscript: "unpublished", patent: "patent",
    newspaperArticle: "article", magazineArticle: "article", encyclopediaArticle: "incollection",
  };
  return map[itemType] || "misc";
}

function bibtexAuthors(data) {
  const creators = (data && data.creators) || [];
  const parts = [];
  for (const creator of creators) {
    if (!creator) continue;
    if (creator.name) { parts.push(creator.name); continue; }
    if (creator.lastName && creator.firstName) { parts.push(creator.lastName + ", " + creator.firstName); continue; }
    if (creator.lastName) parts.push(creator.lastName);
  }
  return parts.join(" and ");
}

function buildBibtex(item) {
  const data = (item && item.data) || {};
  const entryKey = data.citationKey || data.key || item.key || "zotero-item";
  const fields = [];
  const put = function (name, value) {
    if (value === undefined || value === null || value === "") return;
    fields.push("  " + name + " = {" + String(value).replace(/[{}]/g, "") + "}");
  };
  put("title", data.title);
  put("author", bibtexAuthors(data));
  put("year", yearOf(item));
  put("journal", data.publicationTitle);
  put("booktitle", data.proceedingsTitle || data.bookTitle);
  put("publisher", data.publisher);
  put("volume", data.volume);
  put("number", data.issue);
  put("pages", data.pages);
  put("doi", data.DOI);
  put("url", data.url);
  return "@" + bibtexType(data.itemType) + "{" + entryKey + ",\n" + fields.join(",\n") + "\n}";
}

/* ---------------------------------------------------------------- helpers */

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function normalizeFormat(value) {
  return value === "json" ? "json" : "markdown";
}

function encodeKey(key) {
  if (typeof key !== "string" || !key.trim()) throw new Error("Missing item key.");
  return encodeURIComponent(key.trim());
}

/* ------------------------------------------------------------------ tools */

const TOOLS = [];

function defineTool(name, description, inputSchema, handler) {
  TOOLS.push({ name: name, description: description, inputSchema: inputSchema, handler: handler });
}

async function requireLibrary() {
  try {
    return await zoteroFetch("/items/top", { limit: 1 });
  } catch (err) {
    throw err;
  }
}

defineTool(
  "zotero_status",
  "Check the Zotero connection: reports the API base, whether an API key is configured, and whether items can be read. When Zotero is closed or its local API is disabled the reply contains an explicit troubleshooting hint.",
  { type: "object", properties: {}, additionalProperties: false },
  async function () {
    const info = {
      apiBase: CONFIG.apiBase,
      apiKeyConfigured: CONFIG.apiKey.length > 0,
      timeoutMs: CONFIG.timeoutMs,
    };
    try {
      const sample = await requireLibrary();
      info.connected = true;
      info.sampleSize = Array.isArray(sample) ? sample.length : 0;
      return text("Zotero connection OK.\n\n" + JSON.stringify(info, null, 2));
    } catch (err) {
      info.connected = false;
      info.error = err.message;
      return text("Zotero connection failed.\n\n" + JSON.stringify(info, null, 2), true);
    }
  }
);

defineTool(
  "zotero_search_items",
  "Search the Zotero library. Filter by keyword, item type, tag or collection; combine query with qmode=everything for full-text search. Returns each item's title, creators, year and key.",
  {
    type: "object",
    properties: {
      query: { type: "string", description: "Free-text query; leave empty to browse with the other filters" },
      qmode: { type: "string", enum: ["titleCreatorYear", "everything"], description: "Search scope. Defaults to titleCreatorYear; everything also searches full text" },
      itemType: { type: "string", description: "Item type, e.g. journalArticle, book, conferencePaper" },
      tag: { type: "string", description: "Tag" },
      collection: { type: "string", description: "Collection key; restrict the search to this collection" },
      top: { type: "boolean", description: "Return only top-level items (no attachments or notes). Defaults to true" },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Number of items to return. Defaults to 25" },
      start: { type: "integer", minimum: 0, description: "Pagination offset" },
      sort: { type: "string", description: "Sort field, e.g. dateAdded, dateModified, title, creator" },
      direction: { type: "string", enum: ["asc", "desc"] },
      format: { type: "string", enum: ["markdown", "json"], description: "Output format. Defaults to markdown" },
    },
    additionalProperties: false,
  },
  async function (args) {
    const path = args.collection
      ? "/collections/" + encodeKey(args.collection) + "/items"
      : "/items";
    const suffix = args.top === false ? "" : "/top";
    const items = await zoteroFetch(path + suffix, {
      q: args.query,
      qmode: args.query ? (args.qmode || "titleCreatorYear") : undefined,
      itemType: args.itemType,
      tag: args.tag,
      limit: clampLimit(args.limit, 25, 100),
      start: args.start,
      sort: args.sort,
      direction: args.direction,
    });
    return text(renderItems(items, normalizeFormat(args.format)));
  }
);

defineTool(
  "zotero_get_item",
  "Fetch the complete metadata (JSON) of a single Zotero item by key.",
  {
    type: "object",
    properties: { key: { type: "string", description: "Item key" } },
    required: ["key"],
    additionalProperties: false,
  },
  async function (args) {
    const item = await zoteroFetch("/items/" + encodeKey(args.key), {});
    return text(JSON.stringify(item, null, 2));
  }
);

defineTool(
  "zotero_get_item_children",
  "List an item's children: attachments and notes. Use it to locate the PDF attachment of a reference.",
  {
    type: "object",
    properties: {
      key: { type: "string", description: "Parent item key" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      format: { type: "string", enum: ["markdown", "json"] },
    },
    required: ["key"],
    additionalProperties: false,
  },
  async function (args) {
    const children = await zoteroFetch("/items/" + encodeKey(args.key) + "/children", {
      limit: clampLimit(args.limit, 50, 100),
    });
    if (normalizeFormat(args.format) === "json") return text(JSON.stringify(children, null, 2));
    return text(renderItems(children, "markdown"));
  }
);

defineTool(
  "zotero_get_fulltext",
  "Read the indexed full text of a Zotero attachment (PDF and friends). Call zotero_get_item_children first to find the attachment key. Zotero must already have indexed that attachment.",
  {
    type: "object",
    properties: {
      key: { type: "string", description: "Attachment key" },
      maxChars: { type: "integer", minimum: 100, maximum: 200000, description: "Maximum characters to return. Defaults to 20000" },
      offset: { type: "integer", minimum: 0, description: "Character offset to start from; page through long documents together with maxChars" },
    },
    required: ["key"],
    additionalProperties: false,
  },
  async function (args) {
    const payload = await zoteroFetch("/items/" + encodeKey(args.key) + "/fulltext", {});
    if (!payload || typeof payload !== "object") return text(String(payload || "(no full text)"));
    const content = String(payload.content || "");
    if (!content) {
      return text("Zotero returned no full text for this attachment (it may not be indexed yet, or the item is not an attachment).\n"
        + JSON.stringify(payload, null, 2));
    }
    const maxChars = clampLimit(args.maxChars, 20000, 200000);
    const rawOffset = Number(args.offset);
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const slice = content.slice(offset, offset + maxChars);
    const head = (offset > 0 || content.length > offset + maxChars)
      ? "[chars " + offset + "-" + (offset + slice.length) + " of " + content.length + "]\n"
      : "";
    const more = content.length > offset + maxChars
      ? "\n\n… (" + (content.length - offset - maxChars) + " characters left; continue with offset=" + (offset + maxChars) + ")"
      : "";
    return text(head + slice + more);
  }
);

defineTool(
  "zotero_list_collections",
  "List every collection in the Zotero library with its key and item count.",
  {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 },
      start: { type: "integer", minimum: 0 },
      format: { type: "string", enum: ["markdown", "json"] },
    },
    additionalProperties: false,
  },
  async function (args) {
    const collections = await zoteroFetch("/collections", {
      limit: clampLimit(args.limit, 100, 100),
      start: args.start,
    });
    return text(renderCollections(collections, normalizeFormat(args.format)));
  }
);

defineTool(
  "zotero_get_collection_items",
  "List the items in a collection. Call zotero_list_collections first to get its key.",
  {
    type: "object",
    properties: {
      collection: { type: "string", description: "Collection key" },
      top: { type: "boolean", description: "Return only top-level items. Defaults to true" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      start: { type: "integer", minimum: 0 },
      format: { type: "string", enum: ["markdown", "json"] },
    },
    required: ["collection"],
    additionalProperties: false,
  },
  async function (args) {
    const suffix = args.top === false ? "" : "/top";
    const items = await zoteroFetch("/collections/" + encodeKey(args.collection) + "/items" + suffix, {
      limit: clampLimit(args.limit, 50, 100),
      start: args.start,
    });
    return text(renderItems(items, normalizeFormat(args.format)));
  }
);

defineTool(
  "zotero_list_tags",
  "List the library's tags together with the number of items under each tag.",
  {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 200 },
      start: { type: "integer", minimum: 0 },
      format: { type: "string", enum: ["markdown", "json"] },
    },
    additionalProperties: false,
  },
  async function (args) {
    const tags = await zoteroFetch("/tags", {
      limit: clampLimit(args.limit, 100, 200),
      start: args.start,
    });
    return text(renderTags(tags, normalizeFormat(args.format)));
  }
);

defineTool(
  "zotero_get_recent_items",
  "Return the most recently added items, newest first. Useful for questions such as \"what did I add recently?\".",
  {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1, maximum: 100 },
      format: { type: "string", enum: ["markdown", "json"] },
    },
    additionalProperties: false,
  },
  async function (args) {
    const items = await zoteroFetch("/items/top", {
      sort: "dateAdded",
      direction: "desc",
      limit: clampLimit(args.limit, 20, 100),
    });
    return text(renderItems(items, normalizeFormat(args.format)));
  }
);

defineTool(
  "zotero_get_bibtex",
  "Export BibTeX or CSL-JSON citations for one or more item keys. Uses Zotero's own exporter first and falls back to local generation.",
  {
    type: "object",
    properties: {
      keys: {
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
        description: "A single key, or an array of keys",
      },
      format: { type: "string", enum: ["bibtex", "csljson"], description: "Defaults to bibtex" },
    },
    required: ["keys"],
    additionalProperties: false,
  },
  async function (args) {
    const rawKeys = Array.isArray(args.keys) ? args.keys : [args.keys];
    const keys = rawKeys
      .filter(function (k) { return typeof k === "string" && k.trim(); })
      .map(function (k) { return k.trim(); });
    if (!keys.length) throw new Error("keys must not be empty.");
    const wanted = args.format === "csljson" ? "csljson" : "bibtex";

    // The Zotero local API only honours "format" on the SINGLE-item endpoint, and
    // its ?itemKey= collection filter also matches child attachments (which yields
    // a citation for the attached PDF instead of the article). So export one key
    // at a time and drop empty responses.
    const parts = [];
    const missing = [];
    for (const key of keys) {
      let body = "";
      try {
        const rawBody = await zoteroFetch("/items/" + encodeURIComponent(key), { format: wanted }, "text/plain");
        body = typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody, null, 2);
      } catch (err) {
        log("warn", "export failed for " + key + " (" + wanted + "): " + err.message);
      }
      if (body && body.trim()) parts.push(body.trim());
      else missing.push(key);
    }
    if (parts.length) {
      const note = missing.length ? "\n\n(these keys could not be exported: " + missing.join(", ") + ")" : "";
      return text(parts.join("\n\n") + note);
    }

    // Nothing came back at all (an endpoint that does not implement exports):
    // rebuild the citation from item metadata ourselves.
    log("warn", "Zotero returned no " + wanted + " export; generating the citation locally instead");
    const items = [];
    for (const key of keys) {
      const item = await zoteroFetch("/items/" + encodeURIComponent(key), {});
      if (item) items.push(item);
    }
    if (!items.length) return text("No items could be fetched for: " + keys.join(", "), true);
    if (wanted === "csljson") return text(JSON.stringify(items, null, 2));
    return text(items.map(buildBibtex).join("\n\n")
      + "\n\n(Note: this BibTeX was generated locally as a fallback; it carries fewer fields than Zotero's own exporter.)");
  }
);

/* -------------------------------------------------------------- resources */

const LIBRARY_RESOURCE_URI = "zotero://library/recent-items";

async function listResources() {
  const resources = [{
    uri: LIBRARY_RESOURCE_URI,
    name: "Zotero: recently added items",
    description: "Recently added top-level items (JSON)",
    mimeType: "application/json",
  }];
  try {
    const collections = await zoteroFetch("/collections", { limit: 100 });
    if (Array.isArray(collections)) {
      for (const collection of collections) {
        const data = (collection && collection.data) || {};
        const key = data.key || collection.key;
        if (!key) continue;
        resources.push({
          uri: "zotero://collection/" + key,
          name: "Zotero collection: " + (data.name || "(unnamed)"),
          description: "Top-level items in this collection (JSON)",
          mimeType: "application/json",
        });
      }
    }
  } catch (err) {
    log("warn", "resources/list could not read collections (Zotero may not be running): " + err.message);
  }
  return { resources: resources };
}

async function readResource(uri) {
  if (typeof uri !== "string" || !uri) throw rpcError(-32602, "Missing resource uri.");
  if (uri === LIBRARY_RESOURCE_URI) {
    const items = await zoteroFetch("/items/top", { sort: "dateAdded", direction: "desc", limit: 25 });
    return { contents: [{ uri: uri, mimeType: "application/json", text: JSON.stringify(items, null, 2) }] };
  }
  const match = /^zotero:\/\/collection\/(.+)$/.exec(uri);
  if (match) {
    const items = await zoteroFetch("/collections/" + encodeURIComponent(match[1]) + "/items/top", { limit: 100 });
    return { contents: [{ uri: uri, mimeType: "application/json", text: JSON.stringify(items, null, 2) }] };
  }
  throw rpcError(-32602, "Unknown resource uri: " + uri);
}

/* ------------------------------------------------------------ MCP handler */

const INSTRUCTIONS = "This is the user's Zotero library. Every tool name starts with zotero_: "
  + "zotero_search_items searches the library, zotero_get_item and zotero_get_item_children read metadata "
  + "and attachments, zotero_get_fulltext reads indexed attachment text, zotero_get_bibtex produces "
  + "citations, and zotero_list_collections / zotero_get_collection_items browse collections. When the user "
  + "refers to \"my library\", \"my Zotero\", \"the papers I saved\" or otherwise asks for an answer grounded "
  + "in their own references, prefer these tools over a web search.";

function handleInitialize(params) {
  const requested = params && typeof params.protocolVersion === "string" ? params.protocolVersion : "(none)";
  log("info", "client requested protocol version " + requested + ", answering with " + PROTOCOL_VERSION);
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    instructions: INSTRUCTIONS,
  };
}

async function handleToolCall(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  let tool = null;
  for (const candidate of TOOLS) if (candidate.name === name) tool = candidate;
  if (!tool) return text("Unknown tool: " + String(name), true);
  try {
    return await tool.handler(args);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return text("Tool " + name + " failed: " + message, true);
  }
}

async function dispatch(method, params) {
  switch (method) {
    case "initialize":
      return handleInitialize(params);
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/roots/list_changed":
      return {};
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: TOOLS.map(function (tool) {
          return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
        }),
      };
    case "tools/call":
      return handleToolCall(params);
    case "resources/list":
      return listResources();
    case "resources/read":
      return readResource(params && params.uri);
    case "resources/templates/list":
      return { resourceTemplates: [] };
    case "prompts/list":
      return { prompts: [] };
    case "logging/setLevel":
      return {};
    default:
      throw rpcError(-32601, "Method not found: " + method);
  }
}

/* --------------------------------------------------------------- transport */

function send(message) {
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch (err) {
    log("error", "Cannot write to stdout: " + (err && err.message ? err.message : String(err)));
  }
}

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch (err) {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  if (!message || typeof message !== "object" || typeof message.method !== "string") {
    if (message && message.id !== undefined && message.id !== null) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Invalid Request" } });
    }
    return;
  }
  const isNotification = message.id === undefined || message.id === null;
  try {
    const result = await dispatch(message.method, message.params || {});
    if (!isNotification) {
      send({ jsonrpc: "2.0", id: message.id, result: result === undefined ? {} : result });
    }
  } catch (err) {
    const code = err && typeof err.code === "number" ? err.code : -32603;
    const message2 = err && err.message ? err.message : String(err);
    if (isNotification) log("warn", "notification failed " + message.method + ": " + message2);
    else send({ jsonrpc: "2.0", id: message.id, error: { code: code, message: message2 } });
  }
}

/* ------------------------------------------------------------------- cli */

function usage() {
  return [
    SERVER_NAME + " " + SERVER_VERSION + " - MCP server for a local Zotero library.",
    "",
    "Usage:",
    "  zotero-harness-bridge [options]",
    "",
    "With no options the server speaks MCP over stdio, which is how an MCP",
    "client (for example DeepSeek Harness) spawns it.",
    "",
    "Options:",
    "  -h, --help          Show this help and exit.",
    "  -V, --version       Print the version and exit.",
    "      --check [--json]  Probe the Zotero API, print a report and exit.",
    "                      Exit code 0 when Zotero is reachable, 1 otherwise.",
    "      --print-config  Print a ready-to-paste MCP client configuration",
    "                      (JSON) built from this machine's real paths.",
    "",
    "Environment (all optional):",
    "  ZOTERO_API_BASE     API base URL. Default: http://127.0.0.1:23119/api/users/0",
    "  ZOTERO_LOCAL_HOST   Host used when ZOTERO_API_BASE is unset. Default: 127.0.0.1",
    "  ZOTERO_LOCAL_PORT   Port used when ZOTERO_API_BASE is unset. Default: 23119",
    "  ZOTERO_LIBRARY_TYPE user | group. Default: user",
    "  ZOTERO_LIBRARY_ID   Library id; 0 = my library for the local API. Default: 0",
    "  ZOTERO_API_KEY      Zotero Web API key. Not needed for the local API.",
    "  ZOTERO_TIMEOUT_MS   Per-request timeout in ms. Default: 30000",
    "",
    "Setup guide: https://github.com/JARRY-DJH/zotero-harness-bridge#readme",
  ].join("\n");
}

function serverEntryPath() {
  try { return fileURLToPath(import.meta.url); } catch (err) { return "src/server.mjs"; }
}

function clientConfig() {
  return {
    mcpServers: {
      zotero: stdioServerConfig({
        nodePath: process.execPath,
        serverPath: serverEntryPath(),
        env: { ZOTERO_API_BASE: CONFIG.apiBase },
      }),
    },
  };
}

async function runCheck(asJson) {
  const report = {
    server: SERVER_NAME + " " + SERVER_VERSION,
    node: process.version + " (" + process.execPath + ")",
    platform: process.platform + " " + process.arch,
    apiBase: CONFIG.apiBase,
    apiKeyConfigured: CONFIG.apiKey.length > 0,
    timeoutMs: CONFIG.timeoutMs,
    connected: false,
  };
  try {
    const sample = await zoteroFetch("/items/top", { limit: 1 });
    report.connected = true;
    report.sampleSize = Array.isArray(sample) ? sample.length : 0;
  } catch (err) {
    report.error = err && err.message ? err.message : String(err);
  }
  if (asJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.connected;
  }
  const lines = ["Zotero bridge self-check"];
  for (const key of ["server", "node", "platform", "apiBase", "apiKeyConfigured", "timeoutMs"]) {
    lines.push("  " + key.padEnd(18) + String(report[key]));
  }
  lines.push("  " + "connected".padEnd(18) + (report.connected ? "yes" : "NO"));
  if (report.connected) lines.push("  " + "sampleSize".padEnd(18) + String(report.sampleSize));
  if (report.error) lines.push("  " + "error".padEnd(18) + report.error);
  process.stdout.write(lines.join("\n") + "\n");
  return report.connected;
}

async function runCli(argv) {
  const args = argv.filter(function (a) { return typeof a === "string" && a !== ""; });
  if (!args.length) return false;
  const first = args[0];
  if (first === "-h" || first === "--help") { process.stdout.write(usage() + "\n"); return true; }
  if (first === "-V" || first === "--version") { process.stdout.write(SERVER_VERSION + "\n"); return true; }
  if (first === "--print-config") { process.stdout.write(JSON.stringify(clientConfig(), null, 2) + "\n"); return true; }
  if (first === "--check") {
    const ok = await runCheck(args.indexOf("--json") !== -1);
    process.exitCode = ok ? 0 : 1;
    return true;
  }
  process.stderr.write("Unknown option: " + first + "\n\n" + usage() + "\n");
  process.exitCode = 2;
  return true;
}

/* --------------------------------------------------------------- transport */

function startStdioServer() {
  let queue = Promise.resolve();
  let buffer = "";

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", function (chunk) {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        queue = queue.then(function () { return handleLine(line); })
          .catch(function (err) { log("error", "crashed while handling a message: " + (err && err.message ? err.message : String(err))); });
      }
      index = buffer.indexOf("\n");
    }
  });
  process.stdin.on("end", function () {
    // Drain queued work first: tool calls need async HTTP round-trips.
    queue.then(function () { process.exit(0); }, function () { process.exit(0); });
  });
  process.stdin.on("error", function (err) { log("error", "stdin error: " + err.message); });
  process.on("SIGTERM", function () { process.exit(0); });
  process.on("SIGINT", function () { process.exit(0); });
  process.on("uncaughtException", function (err) { log("error", "Uncaught exception: " + (err && err.stack ? err.stack : String(err))); });
  process.on("unhandledRejection", function (err) { log("error", "Unhandled promise rejection: " + (err && err.stack ? err.stack : String(err))); });

  log("info", "starting " + SERVER_NAME + " v" + SERVER_VERSION + " -> " + CONFIG.apiBase
    + (CONFIG.apiKey ? " (API key configured)" : " (no API key, local API mode)"));
}

/**
 * True when this file is the entry point of a process (an MCP client spawned
 * it), false when something merely imported it. Keeping the check here makes
 * `import` side-effect free, which is what a test harness needs.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(entry));
  } catch (err) {
    return false;
  }
}

if (isEntryPoint()) {
  const cliHandled = await runCli(process.argv.slice(2));
  if (!cliHandled) startStdioServer();
}
