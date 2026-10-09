/*
 * A small stand-in for the Zotero 7 local HTTP API.
 *
 * The test suite starts it inside the test process, points the bridge at it
 * with ZOTERO_API_BASE and then asserts on both the replies the bridge produced
 * and the requests this server received.
 *
 * It is also runnable on its own, which is handy when you want to poke at the
 * bridge without opening Zotero:
 *
 *     node test/mock-zotero.mjs --port 23199
 *     ZOTERO_API_BASE=http://127.0.0.1:23199/api/users/0 node src/server.mjs --check
 *
 * Importing this file has no side effects.
 */

import http from "node:http";
import process from "node:process";

/** The one library both the mock and the tests agree on. */
export const FIXTURE = {
  topItems: [
    {
      key: "AAAA1111",
      version: 10,
      data: {
        key: "AAAA1111",
        version: 10,
        itemType: "journalArticle",
        title: "Narrative identity and place attachment",
        creators: [
          { creatorType: "author", firstName: "Mei", lastName: "Zhang" },
          { creatorType: "author", firstName: "John", lastName: "Doe" },
        ],
        date: "2021-05-01",
        publicationTitle: "Journal of Environmental Psychology",
        DOI: "10.1000/example.2021.001",
        tags: [{ tag: "narrative" }, { tag: "place" }],
        collections: ["COLL0001"],
        numChildren: 2,
      },
    },
    {
      key: "CCCC3333",
      version: 4,
      data: {
        key: "CCCC3333",
        version: 4,
        itemType: "book",
        title: "Landscape narration: theory and method",
        creators: [{ creatorType: "author", firstName: "Li", lastName: "Wang" }],
        date: "2018",
        publisher: "Science Press",
        tags: [{ tag: "narrative" }],
        collections: ["COLL0001"],
      },
    },
    {
      key: "DDDD4444",
      version: 2,
      data: {
        key: "DDDD4444",
        version: 2,
        itemType: "conferencePaper",
        title: "Spatio-temporal evolution of tourism corridors",
        creators: [{ creatorType: "author", name: "Tourism Research Group" }],
        date: "2020",
        proceedingsTitle: "Proceedings of TRC 2020",
        tags: [{ tag: "landscape" }],
        collections: ["COLL0002"],
      },
    },
  ],

  children: {
    AAAA1111: [
      {
        key: "BBBB2222",
        version: 1,
        data: {
          key: "BBBB2222",
          version: 1,
          itemType: "attachment",
          title: "Full Text PDF",
          contentType: "application/pdf",
          parentItem: "AAAA1111",
        },
      },
      {
        key: "NOTE5555",
        version: 1,
        data: {
          key: "NOTE5555",
          version: 1,
          itemType: "note",
          note: "<p>Read for the corridor chapter.</p>",
          parentItem: "AAAA1111",
        },
      },
    ],
  },

  collections: [
    { key: "COLL0001", version: 1, data: { key: "COLL0001", version: 1, name: "Place & identity", numItems: 2 } },
    { key: "COLL0002", version: 1, data: { key: "COLL0002", version: 1, name: "Methods", numItems: 1 } },
  ],

  tags: [
    { tag: "narrative", meta: { numItems: 2 } },
    { tag: "place", meta: { numItems: 1 } },
    { tag: "landscape", meta: { numItems: 1 } },
  ],

  /** 12 x 45 = 540 characters, so paging has exact expectations. */
  fulltext: {
    BBBB2222: "Place attachment is built through narration. ".repeat(12),
  },

  bibtex: {
    AAAA1111: [
      "@article{zhang_narrative_2021,",
      "  title = {Narrative identity and place attachment},",
      "  author = {Zhang, Mei and Doe, John},",
      "  year = {2021}",
      "}",
    ].join("\n"),
  },
};

function findByKey(key) {
  for (const item of FIXTURE.topItems) if (item.key === key) return item;
  for (const parent of Object.keys(FIXTURE.children)) {
    for (const child of FIXTURE.children[parent]) if (child.key === key) return child;
  }
  return null;
}

function asInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function paginate(rows, query) {
  const start = asInt(query.start, 0);
  const limit = asInt(query.limit, rows.length);
  return rows.slice(start, start + limit);
}

function filterItems(rows, query) {
  let out = rows;
  if (query.itemType) out = out.filter(function (row) { return row.data.itemType === query.itemType; });
  if (query.tag) {
    out = out.filter(function (row) {
      return (row.data.tags || []).some(function (tag) { return tag.tag === query.tag; });
    });
  }
  if (query.q) {
    const needle = String(query.q).toLowerCase();
    out = out.filter(function (row) {
      return String(row.data.title || "").toLowerCase().includes(needle);
    });
  }
  if (query.sort === "dateAdded" && query.direction === "desc") out = out.slice().reverse();
  return out;
}

/**
 * Start the mock server.
 *
 * @param {{ port?: number, disableExports?: boolean, items?: object[] }} options
 * @returns {Promise<{ url: string, port: number, requests: object[], close: () => Promise<void> }>}
 */
export async function startMockZotero(options) {
  const opts = options || {};
  const requests = [];

  const server = http.createServer(function (req, res) {
    const url = new URL(req.url, "http://127.0.0.1");
    const query = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    function sendJson(status, payload) {
      const body = JSON.stringify(payload);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Zotero-API-Version": "3",
      });
      res.end(body);
    }

    function sendText(status, body) {
      res.writeHead(status, {
        "Content-Type": "text/plain",
        "Content-Length": Buffer.byteLength(body),
        "Zotero-API-Version": "3",
      });
      res.end(body);
    }

    const prefix = "/api/users/0";
    if (!url.pathname.startsWith(prefix)) {
      requests.push({ method: req.method, path: url.pathname, query: query });
      return sendJson(404, { error: "unknown library prefix" });
    }
    // Recorded without the library prefix, so tests can talk about "/items/top".
    const rest = url.pathname.slice(prefix.length);
    requests.push({ method: req.method, path: rest, query: query });
    const topItems = opts.items || FIXTURE.topItems;

    if (rest === "/items/top") return sendJson(200, paginate(filterItems(topItems, query), query));
    if (rest === "/items") {
      const all = topItems.concat([].concat.apply([], Object.keys(FIXTURE.children).map(function (k) { return FIXTURE.children[k]; })));
      return sendJson(200, paginate(filterItems(all, query), query));
    }
    if (rest === "/collections") return sendJson(200, paginate(FIXTURE.collections, query));
    if (rest === "/tags") return sendJson(200, paginate(FIXTURE.tags, query));

    let match = /^\/collections\/([^/]+)\/items(\/top)?$/.exec(rest);
    if (match) {
      const wanted = match[1];
      const rows = topItems.filter(function (row) {
        return (row.data.collections || []).indexOf(wanted) !== -1;
      });
      return sendJson(200, paginate(rows, query));
    }

    match = /^\/items\/([^/]+)\/children$/.exec(rest);
    if (match) return sendJson(200, paginate(FIXTURE.children[match[1]] || [], query));

    match = /^\/items\/([^/]+)\/fulltext$/.exec(rest);
    if (match) {
      const content = FIXTURE.fulltext[match[1]];
      if (content === undefined) return sendJson(404, { error: "no such attachment" });
      return sendJson(200, { content: content, indexedChars: content.length, totalChars: content.length });
    }

    match = /^\/items\/([^/]+)$/.exec(rest);
    if (match) {
      const key = match[1];
      if (query.format === "bibtex") {
        if (opts.disableExports) return sendText(200, "");
        return sendText(200, FIXTURE.bibtex[key] || "");
      }
      if (query.format === "csljson") {
        if (opts.disableExports) return sendText(200, "");
        const item = findByKey(key);
        return sendText(200, item ? JSON.stringify([item]) : "");
      }
      const item = findByKey(key);
      if (!item) return sendJson(404, { error: "no such item" });
      return sendJson(200, item);
    }

    return sendJson(404, { error: "unhandled path " + rest });
  });

  await new Promise(function (resolve, reject) {
    server.once("error", reject);
    server.listen(opts.port === undefined ? 0 : opts.port, "127.0.0.1", resolve);
  });

  const port = server.address().port;
  return {
    url: "http://127.0.0.1:" + port + "/api/users/0",
    port: port,
    requests: requests,
    close: function () {
      return new Promise(function (resolve) { server.close(function () { resolve(); }); });
    },
  };
}

/* --------------------------------------------------------------- CLI mode */

function isEntryPoint() {
  return process.argv[1] && process.argv[1].endsWith("mock-zotero.mjs");
}

if (isEntryPoint()) {
  const portIndex = process.argv.indexOf("--port");
  const port = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 23199;
  const mock = await startMockZotero({ port: port });
  process.stdout.write("mock Zotero API listening on " + mock.url + "\n");
}
