/*
 * Test suite for zotero-harness-bridge.
 *
 * Everything here runs without Zotero: ./mock-zotero.mjs stands in for the
 * Zotero 7 local API, and the bridge is exercised as a real child process over
 * its real stdio transport.
 *
 *     npm test
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { FIXTURE, startMockZotero } from "./mock-zotero.mjs";
import {
  SERVER_NAME,
  readVersion,
  resolveApiBase,
  resolveApiKey,
  resolveTimeoutMs,
  serverEnv,
  stdioServerConfig,
} from "../src/config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SERVER_ENTRY = path.join(REPO, "src", "server.mjs");
const SERVER_URL = pathToFileURL(SERVER_ENTRY).href;
const PACKAGE = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8"));
const PROTOCOL = "2025-11-25";

/* ---------------------------------------------------------------- harness */

/** process.env without any ZOTERO_* leakage from the machine running the tests. */
function hermeticEnv(overrides) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^ZOTERO_/i.test(key)) continue;
    env[key] = value;
  }
  return Object.assign(env, overrides || {});
}

/**
 * Run the bridge once and collect everything it emitted.
 *
 * stdio is wired to temporary files instead of pipes on purpose. A pipe is a
 * named kernel object and some sandboxes refuse to create one, which would make
 * this suite unrunnable there; file descriptors work everywhere, and the bridge
 * handles EOF on stdin exactly like a client closing the connection.
 */
async function runServer(options) {
  const opts = options || {};
  const timeoutMs = opts.timeoutMs || 20000;
  const dir = mkdtempSync(path.join(tmpdir(), "zhb-test-"));
  const inFile = path.join(dir, "stdin.jsonl");
  const outFile = path.join(dir, "stdout.jsonl");
  const errFile = path.join(dir, "stderr.log");
  const requests = opts.requests || [];
  const lines = requests.map(function (request) {
    return typeof request === "string" ? request : JSON.stringify(request);
  });
  writeFileSync(inFile, lines.join("\n") + (lines.length ? "\n" : ""), "utf8");

  const fds = [openSync(inFile, "r"), openSync(outFile, "w"), openSync(errFile, "w")];
  const result = { code: null, stdout: "", stderr: "", messages: [] };
  try {
    try {
      const child = spawn(process.execPath, [SERVER_ENTRY].concat(opts.args || []), {
        stdio: fds,
        env: hermeticEnv(opts.env),
        windowsHide: true,
      });
      await new Promise(function (resolve, reject) {
        const timer = setTimeout(function () {
          try { child.kill(); } catch (err) { /* already gone */ }
          reject(new Error("the bridge did not exit within " + timeoutMs + " ms"));
        }, timeoutMs);
        child.once("error", function (err) { clearTimeout(timer); reject(err); });
        child.once("close", function (code) { clearTimeout(timer); result.code = code; resolve(); });
      });
    } finally {
      for (const fd of fds) {
        try { closeSync(fd); } catch (err) { /* already closed */ }
      }
      result.stdout = readFileSync(outFile, "utf8");
      result.stderr = readFileSync(errFile, "utf8");
      rmSync(dir, { recursive: true, force: true });
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  return result;
}

/** Same as runServer, but for transcripts where every stdout line is JSON-RPC. */
async function runSession(requests, options) {
  const run = await runServer(Object.assign({}, options, { requests: requests }));
  for (const line of run.stdout.split(/\r?\n/)) {
    if (line) run.messages.push(JSON.parse(line));
  }
  return run;
}

function rpc(id, method, params) {
  const message = { jsonrpc: "2.0", id: id, method: method };
  if (params !== undefined) message.params = params;
  return message;
}

const INITIALIZE = rpc(1, "initialize", {
  protocolVersion: PROTOCOL,
  capabilities: {},
  clientInfo: { name: "zhb-tests", version: "0" },
});
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

/** Start a mock library, hand it to the callback, always shut it down again. */
async function withMock(options, callback) {
  const mock = await startMockZotero(options || {});
  try {
    return await callback(mock);
  } finally {
    await mock.close();
  }
}

/** Drive one initialize + one tools/call and return what the tool produced. */
async function callTool(name, args, options) {
  const opts = options || {};
  const env = Object.assign({}, opts.env);
  if (opts.mock) env.ZOTERO_API_BASE = opts.mock.url;
  const run = await runSession(
    [INITIALIZE, INITIALIZED, rpc(2, "tools/call", { name: name, arguments: args || {} })],
    { env: env }
  );
  const reply = run.messages.find(function (message) { return message.id === 2; });
  assert.ok(reply, "no reply for " + name + "; stderr was:\n" + run.stderr);
  assert.ok(reply.result, "expected a result for " + name + ", got " + JSON.stringify(reply.error));
  const content = reply.result.content || [];
  return {
    text: String((content[0] && content[0].text) || ""),
    isError: reply.result.isError === true,
    result: reply.result,
    run: run,
  };
}

function lastRequest(mock, requestPath) {
  const hits = mock.requests.filter(function (request) { return request.path === requestPath; });
  assert.ok(hits.length, "the bridge never called " + requestPath + "; it called " +
    mock.requests.map(function (r) { return r.path; }).join(", "));
  return hits[hits.length - 1];
}

/* ------------------------------------------------------------ MCP surface */

test("initialize negotiates the protocol and advertises tools and resources", async () => {
  const run = await runSession([INITIALIZE]);
  assert.equal(run.code, 0);
  assert.equal(run.messages.length, 1, "initialize must produce exactly one reply");
  const result = run.messages[0].result;
  assert.equal(run.messages[0].id, 1);
  assert.equal(result.protocolVersion, PROTOCOL);
  assert.equal(result.serverInfo.name, SERVER_NAME);
  assert.equal(result.serverInfo.version, PACKAGE.version);
  assert.ok(result.capabilities.tools, "tools capability is missing");
  assert.ok(result.capabilities.resources, "resources capability is missing");
  assert.match(result.instructions, /zotero_search_items/);
});

test("tools/list exposes ten zotero tools with usable schemas", async () => {
  const run = await runSession([INITIALIZE, rpc(2, "tools/list")]);
  const tools = run.messages.find(function (m) { return m.id === 2; }).result.tools;
  assert.equal(tools.length, 10);
  for (const tool of tools) {
    assert.match(tool.name, /^zotero_[a-z_]+$/, "unexpected tool name " + tool.name);
    assert.ok(tool.description && tool.description.length > 20, tool.name + " needs a real description");
    assert.equal(tool.inputSchema.type, "object", tool.name + " must take an object");
  }
  const names = tools.map(function (tool) { return tool.name; });
  assert.deepEqual(names.slice().sort(), [
    "zotero_get_bibtex",
    "zotero_get_collection_items",
    "zotero_get_fulltext",
    "zotero_get_item",
    "zotero_get_item_children",
    "zotero_get_recent_items",
    "zotero_list_collections",
    "zotero_list_tags",
    "zotero_search_items",
    "zotero_status",
  ]);
});

test("resources/list and resources/read expose the library", async () => {
  await withMock({}, async function (mock) {
    const run = await runSession(
      [
        INITIALIZE,
        rpc(2, "resources/list"),
        rpc(3, "resources/read", { uri: "zotero://library/recent-items" }),
        rpc(4, "resources/read", { uri: "zotero://collection/COLL0001" }),
      ],
      { env: { ZOTERO_API_BASE: mock.url } }
    );
    const list = run.messages.find(function (m) { return m.id === 2; }).result.resources;
    const uris = list.map(function (resource) { return resource.uri; });
    assert.ok(uris.includes("zotero://library/recent-items"));
    assert.ok(uris.includes("zotero://collection/COLL0001"));
    assert.ok(uris.includes("zotero://collection/COLL0002"));

    const recent = JSON.parse(run.messages.find(function (m) { return m.id === 3; }).result.contents[0].text);
    assert.equal(recent.length, FIXTURE.topItems.length);
    const collection = JSON.parse(run.messages.find(function (m) { return m.id === 4; }).result.contents[0].text);
    assert.equal(collection.length, 2, "COLL0001 holds two fixture items");
  });
});

test("resources/read rejects an unknown uri", async () => {
  const run = await runSession([INITIALIZE, rpc(2, "resources/read", { uri: "zotero://nope" })]);
  const reply = run.messages.find(function (m) { return m.id === 2; });
  assert.equal(reply.error.code, -32602);
  assert.match(reply.error.message, /Unknown resource uri/);
});

/* ------------------------------------------------------------------ tools */

test("zotero_status reports a healthy connection", async () => {
  await withMock({}, async function (mock) {
    const out = await callTool("zotero_status", {}, { mock: mock });
    assert.equal(out.isError, false);
    assert.match(out.text, /Zotero connection OK/);
    assert.match(out.text, /"connected": true/);
    assert.match(out.text, /"apiKeyConfigured": false/);
    assert.ok(out.text.includes(mock.url), "the report should name the API base it used");
  });
});

test("zotero_search_items forwards every filter to Zotero", async () => {
  await withMock({}, async function (mock) {
    const out = await callTool("zotero_search_items", { query: "narrative" }, { mock: mock });
    assert.equal(out.isError, false);
    assert.match(out.text, /Narrative identity and place attachment/);
    assert.doesNotMatch(out.text, /Landscape narration/, "the mock filters on the query");

    const request = lastRequest(mock, "/items/top");
    assert.equal(request.query.q, "narrative");
    assert.equal(request.query.qmode, "titleCreatorYear", "qmode must default when a query is present");
    assert.equal(request.query.limit, "25", "limit must default to 25");

    await callTool("zotero_search_items", { query: "narrative", qmode: "everything", limit: 500 }, { mock: mock });
    const everything = lastRequest(mock, "/items/top");
    assert.equal(everything.query.qmode, "everything");
    assert.equal(everything.query.limit, "100", "limit must be clamped to 100");

    await callTool("zotero_search_items", { collection: "COLL0001", top: false }, { mock: mock });
    assert.equal(lastRequest(mock, "/collections/COLL0001/items").query.q, undefined);
  });
});

test("zotero_search_items can emit JSON and reports an empty library plainly", async () => {
  await withMock({ items: [] }, async function (mock) {
    const json = await callTool("zotero_search_items", { format: "json" }, { mock: mock });
    assert.deepEqual(JSON.parse(json.text), []);
    const markdown = await callTool("zotero_search_items", {}, { mock: mock });
    assert.equal(markdown.text, "No matching items.");
  });
});

test("zotero_get_item returns the complete record", async () => {
  await withMock({}, async function (mock) {
    const out = await callTool("zotero_get_item", { key: "CCCC3333" }, { mock: mock });
    const item = JSON.parse(out.text);
    assert.equal(item.key, "CCCC3333");
    assert.equal(item.data.itemType, "book");
    assert.equal(item.data.publisher, "Science Press");
  });
});

test("zotero_get_item_children lists attachments and notes", async () => {
  await withMock({}, async function (mock) {
    const out = await callTool("zotero_get_item_children", { key: "AAAA1111" }, { mock: mock });
    assert.match(out.text, /Full Text PDF/);
    assert.match(out.text, /key=BBBB2222/);
    assert.match(out.text, /key=NOTE5555/);
    assert.equal(lastRequest(mock, "/items/AAAA1111/children").query.limit, "50");
  });
});

test("zotero_get_fulltext pages through a long attachment", async () => {
  await withMock({}, async function (mock) {
    const total = FIXTURE.fulltext.BBBB2222.length;
    assert.equal(total, 540, "the fixture must stay pageable at exact offsets");

    const first = await callTool("zotero_get_fulltext", { key: "BBBB2222", maxChars: 45 }, { mock: mock });
    assert.ok(first.text.startsWith("[chars 0-45 of 540]\n"), "unexpected header: " + first.text.slice(0, 40));
    assert.match(first.text, /495 characters left; continue with offset=45/);

    const second = await callTool("zotero_get_fulltext", { key: "BBBB2222", maxChars: 45, offset: 495 }, { mock: mock });
    assert.ok(second.text.startsWith("[chars 495-540 of 540]\n"));
    assert.doesNotMatch(second.text, /characters left/, "the last page must not advertise more");
  });
});

test("zotero_list_collections and zotero_get_collection_items agree with each other", async () => {
  await withMock({}, async function (mock) {
    const collections = await callTool("zotero_list_collections", {}, { mock: mock });
    assert.match(collections.text, /Place & identity/);
    assert.match(collections.text, /key=COLL0001 {2}items=2/);

    const items = await callTool("zotero_get_collection_items", { collection: "COLL0001" }, { mock: mock });
    assert.match(items.text, /Narrative identity and place attachment/);
    assert.match(items.text, /Landscape narration/);
    assert.doesNotMatch(items.text, /tourism corridors/);
  });
});

test("zotero_list_tags lists tags with counts", async () => {
  await withMock({}, async function (mock) {
    const out = await callTool("zotero_list_tags", {}, { mock: mock });
    assert.match(out.text, /- narrative \(2\)/);
    assert.match(out.text, /- landscape \(1\)/);
  });
});

test("zotero_get_recent_items asks Zotero for newest first", async () => {
  await withMock({}, async function (mock) {
    const out = await callTool("zotero_get_recent_items", { limit: 2 }, { mock: mock });
    const request = lastRequest(mock, "/items/top");
    assert.equal(request.query.sort, "dateAdded");
    assert.equal(request.query.direction, "desc");
    assert.equal(request.query.limit, "2");
    assert.ok(
      out.text.indexOf("tourism corridors") < out.text.indexOf("Landscape narration"),
      "the mock reverse only happens when the sort parameters arrive"
    );
  });
});

test("zotero_get_bibtex uses Zotero's own exporter when it works", async () => {
  await withMock({}, async function (mock) {
    const out = await callTool("zotero_get_bibtex", { keys: ["AAAA1111", "CCCC3333"] }, { mock: mock });
    assert.equal(out.isError, false);
    assert.match(out.text, /@article\{zhang_narrative_2021,/);
    assert.match(out.text, /\(these keys could not be exported: CCCC3333\)/);
    const request = lastRequest(mock, "/items/AAAA1111");
    assert.equal(request.query.format, "bibtex");
  });
});

test("zotero_get_bibtex falls back to local generation and says so", async () => {
  await withMock({ disableExports: true }, async function (mock) {
    const bibtex = await callTool("zotero_get_bibtex", { keys: ["AAAA1111"] }, { mock: mock });
    assert.equal(bibtex.isError, false);
    assert.match(bibtex.text, /@article\{AAAA1111,/);
    assert.match(bibtex.text, /generated locally as a fallback/);

    const csl = await callTool("zotero_get_bibtex", { keys: ["AAAA1111"], format: "csljson" }, { mock: mock });
    const parsed = JSON.parse(csl.text);
    assert.equal(parsed[0].key, "AAAA1111");
  });
});

test("zotero_get_bibtex refuses an empty key list", async () => {
  await withMock({}, async function (mock) {
    const out = await callTool("zotero_get_bibtex", { keys: ["   "] }, { mock: mock });
    assert.equal(out.isError, true);
    assert.match(out.text, /keys must not be empty/);
  });
});

/* ------------------------------------------------------------- resilience */

test("an unknown tool is reported as a tool error, not a crash", async () => {
  await withMock({}, async function (mock) {
    const out = await callTool("no_such_tool", {}, { mock: mock });
    assert.equal(out.isError, true);
    assert.match(out.text, /Unknown tool: no_such_tool/);
  });
});

test("the session survives a failing call and keeps answering", async () => {
  await withMock({}, async function (mock) {
    const run = await runSession(
      [
        INITIALIZE,
        rpc(2, "tools/call", { name: "zotero_get_item", arguments: { key: "NOPE0000" } }),
        rpc(3, "tools/call", { name: "zotero_status", arguments: {} }),
      ],
      { env: { ZOTERO_API_BASE: mock.url } }
    );
    assert.equal(run.code, 0);
    const failure = run.messages.find(function (m) { return m.id === 2; }).result;
    assert.equal(failure.isError, true);
    assert.match(failure.content[0].text, /404/);
    const ok = run.messages.find(function (m) { return m.id === 3; }).result;
    assert.equal(ok.isError, false, "the next call must still work");
  });
});

test("unknown methods, malformed input and notifications follow JSON-RPC", async () => {
  const run = await runSession([
    INITIALIZE,
    INITIALIZED,
    rpc(2, "does/not/exist"),
    "{ this is not json",
    '{"jsonrpc":"2.0","id":9}',
    rpc(4, "ping"),
  ]);
  assert.equal(run.code, 0, "a malformed line must not bring the server down");
  const byId = new Map();
  for (const message of run.messages) byId.set(message.id, message);
  assert.equal(byId.get(2).error.code, -32601, "unknown method");
  assert.equal(byId.get(null).error.code, -32700, "parse error");
  assert.equal(byId.get(9).error.code, -32600, "invalid request");
  assert.deepEqual(byId.get(4).result, {}, "ping is answered with an empty result");
  assert.equal(run.messages.length, 5, "the notification must not be answered");
});

test("a closed Zotero fails every tool with a readable explanation", async () => {
  const mock = await startMockZotero({});
  const deadUrl = mock.url;
  await mock.close();

  const status = await callTool("zotero_status", {}, { env: { ZOTERO_API_BASE: deadUrl } });
  assert.equal(status.isError, true);
  assert.match(status.text, /Cannot reach Zotero/);
  assert.match(status.text, /Zotero desktop app is running/);
  assert.match(status.text, /"connected": false/);

  for (const name of ["zotero_search_items", "zotero_list_collections", "zotero_list_tags", "zotero_get_recent_items"]) {
    const out = await callTool(name, {}, { env: { ZOTERO_API_BASE: deadUrl } });
    assert.equal(out.isError, true, name + " must fail loudly when Zotero is closed");
    assert.match(out.text, /Cannot reach Zotero/);
  }
});

/* -------------------------------------------------------------------- CLI */

test("CLI: --version and --help work without Zotero", async () => {
  const version = await runServer({ args: ["--version"] });
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), PACKAGE.version);

  const help = await runServer({ args: ["--help"] });
  assert.equal(help.code, 0);
  for (const needle of ["ZOTERO_API_BASE", "--check", "--print-config", "zotero-harness-bridge"]) {
    assert.ok(help.stdout.includes(needle), "--help should mention " + needle);
  }
});

test("CLI: --print-config emits this machine's real paths", async () => {
  const run = await runServer({ args: ["--print-config"] });
  assert.equal(run.code, 0);
  const config = JSON.parse(run.stdout);
  const server = config.mcpServers.zotero;
  assert.equal(server.command, process.execPath);
  assert.equal(path.resolve(server.args[0]), SERVER_ENTRY);
  assert.equal(server.env.ZOTERO_API_BASE, resolveApiBase({}));
});

test("CLI: --check reports reachable and unreachable Zotero with the right exit code", async () => {
  await withMock({}, async function (mock) {
    const live = await runServer({ args: ["--check", "--json"], env: { ZOTERO_API_BASE: mock.url } });
    assert.equal(live.code, 0);
    const report = JSON.parse(live.stdout);
    assert.equal(report.connected, true);
    assert.equal(report.apiBase, mock.url);
    assert.equal(report.server, SERVER_NAME + " " + PACKAGE.version);
  });

  const mock = await startMockZotero({});
  const deadUrl = mock.url;
  await mock.close();
  const dead = await runServer({ args: ["--check"], env: { ZOTERO_API_BASE: deadUrl } });
  assert.equal(dead.code, 1);
  assert.match(dead.stdout, /connected {2,}NO/);
  assert.match(dead.stdout, /Cannot reach Zotero/);
});

test("CLI: an unknown option fails with exit code 2", async () => {
  const run = await runServer({ args: ["--nope"] });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /Unknown option: --nope/);
  assert.match(run.stderr, /Usage:/);
});

/* ------------------------------------------------------------ config unit */

test("configuration defaults are portable", () => {
  assert.equal(resolveApiBase({}), "http://127.0.0.1:23119/api/users/0");
  assert.equal(resolveApiBase({ ZOTERO_LOCAL_PORT: "9999" }), "http://127.0.0.1:9999/api/users/0");
  assert.equal(resolveApiBase({ ZOTERO_LOCAL_HOST: "localhost", ZOTERO_LOCAL_PORT: "8080" }), "http://localhost:8080/api/users/0");
  assert.equal(resolveApiBase({ ZOTERO_LIBRARY_TYPE: "group", ZOTERO_LIBRARY_ID: "42" }), "http://127.0.0.1:23119/api/groups/42");
  assert.equal(resolveApiBase({ ZOTERO_API_BASE: "https://api.zotero.org/users/7///" }), "https://api.zotero.org/users/7");
  assert.equal(resolveApiBase({ ZOTERO_API_BASE: "https://api.zotero.org/users/7", ZOTERO_LOCAL_PORT: "1" }),
    "https://api.zotero.org/users/7", "an explicit base must win");
  assert.equal(resolveApiBase({ ZOTERO_API_BASE: "   " }), "http://127.0.0.1:23119/api/users/0", "blank means unset");

  assert.equal(resolveApiKey({}), "");
  assert.equal(resolveApiKey({ ZOTERO_API_KEY: " secret " }), "secret");

  assert.equal(resolveTimeoutMs({}), 30000);
  assert.equal(resolveTimeoutMs({ ZOTERO_TIMEOUT_MS: "4500" }), 4500);
  assert.equal(resolveTimeoutMs({ ZOTERO_TIMEOUT_MS: "nonsense" }), 30000);
  assert.equal(resolveTimeoutMs({ ZOTERO_TIMEOUT_MS: "-1" }), 30000);
});

test("serverEnv drops empty values and always carries a base URL", () => {
  const env = serverEnv({ ZOTERO_API_BASE: "", ZOTERO_API_KEY: undefined, EXTRA: "yes" });
  assert.equal(env.ZOTERO_API_BASE, resolveApiBase({}));
  assert.equal(env.ZOTERO_API_KEY, undefined);
  assert.equal(env.EXTRA, "yes");

  const configured = serverEnv({ ZOTERO_API_BASE: "http://example.test/api/users/0" });
  assert.equal(configured.ZOTERO_API_BASE, "http://example.test/api/users/0");

  const stdio = stdioServerConfig({ nodePath: "/usr/bin/node", serverPath: "/srv/server.mjs", env: {} });
  assert.equal(stdio.command, "/usr/bin/node");
  assert.deepEqual(stdio.args, ["/srv/server.mjs"]);
  assert.equal(stdio.env.ZOTERO_API_BASE, resolveApiBase({}));
});

test("the version reported by the code matches package.json", () => {
  assert.equal(readVersion(), PACKAGE.version);
});

/* --------------------------------------------------------- hygiene checks */

test("the package stays dependency-free", () => {
  assert.equal(PACKAGE.dependencies, undefined, "a runtime dependency would break the zero-install promise");
  assert.equal(PACKAGE.peerDependencies, undefined);
  assert.ok(PACKAGE.engines.node, "engines.node must be declared");
  assert.equal(PACKAGE.license, "MIT");
});

test("every import is a Node built-in or a file in this repository", async () => {
  const sources = ["src/server.mjs", "src/config.mjs", "scripts/setup.mjs", "test/mock-zotero.mjs"];
  for (const relative of sources) {
    const source = readFileSync(path.join(REPO, relative), "utf8");
    for (const match of source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)) {
      const specifier = match[1];
      assert.ok(
        specifier.startsWith("node:") || specifier.startsWith("."),
        relative + " imports " + specifier + ", which is neither a built-in nor a relative file"
      );
    }
  }
});

test("the committed tree carries no scratch files or machine-specific paths", () => {
  const forbiddenNames = [
    { pattern: /\.jsonl$/, label: "a captured protocol transcript" },
    { pattern: /\.stderr\.log$/, label: "a captured stderr dump" },
    { pattern: /\.bak$/, label: "a backup copy" },
    { pattern: /^(backup|vendor|tools|node_modules)[\\/]/, label: "a development directory that was meant to be removed" },
  ];
  const skip = new Set(["node_modules", ".git"]);
  const offenders = [];
  const walk = function (dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const relative = path.relative(REPO, full).split(path.sep).join("/");
      for (const rule of forbiddenNames) {
        if (rule.pattern.test(relative)) offenders.push(relative + " (" + rule.label + ")");
      }
      if (/\.(mjs|js|json|md|ya?ml)$/.test(relative)) {
        const text = readFileSync(full, "utf8");
        if (/[A-Za-z]:\\Users\\(?!\.\.\.)/.test(text)) {
          offenders.push(relative + " (a hard-coded user directory)");
        }
      }
    }
  };
  walk(REPO);
  assert.deepEqual(offenders, []);
});

test("importing the server module does not start a server", async () => {
  const before = process.stdin.listenerCount("data");
  await import(SERVER_URL);
  assert.equal(process.stdin.listenerCount("data"), before, "the module must stay import-safe");
});
