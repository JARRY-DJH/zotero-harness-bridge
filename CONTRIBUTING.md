# Contributing

Thanks for taking the time to improve `zotero-harness-bridge`.

## Ground rules

1. **Zero runtime dependencies.** The server may only import Node built-ins
   (`node:*`) and files from `src/`. It must keep running on a machine with no
   network access and no `node_modules`. Please do not add packages, bundlers,
   TypeScript or a build step.
2. **No machine-specific values.** Absolute paths, hostnames, ports and URLs
   belong in environment variables or in `examples/` as placeholders
   (`<NODE_EXECUTABLE>`, `<SERVER_ENTRY>`). A pull request that hard-codes a
   `C:\Users\...` path will be asked to change.
3. **Keep the protocol surface honest.** If you add a tool, document it in the
   README tool table and give it a description a model can act on.
4. **English** for code, comments, docs and everything the model reads.

## Getting started

    git clone https://github.com/JARRY-DJH/zotero-harness-bridge.git
    cd zotero-harness-bridge
    node src/server.mjs --check

There is nothing to install: the project has no dependencies.

## Trying it against a real Zotero

1. Start Zotero 7 and enable
   *Edit > Settings > Advanced > Allow other applications on this computer to
   communicate with Zotero*.
2. Run `node src/server.mjs --check` and confirm it reports `connected yes`.
3. Register the server with your MCP client using `node scripts/setup.mjs`.

## Trying it without Zotero

`node src/server.mjs` speaks newline-delimited JSON-RPC on stdin/stdout. You can
drive it by hand:

    printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"cli","version":"0"}}}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | node src/server.mjs

Tool calls that reach Zotero will fail while it is closed; that is expected and
is reported as an `isError` result rather than a crash.

## Running the tests

    npm test

`test/mock-zotero.mjs` implements enough of the Zotero local API for the whole
surface to be exercised offline, and `test/server.test.mjs` runs the bridge as
a real child process over its real stdio transport. Nothing is mocked inside
the bridge itself.

The suite spawns the child with file descriptors rather than pipes. That is
deliberate: a pipe is a named kernel object, and sandboxes such as DSH's
refuse to create one, which would make the suite unrunnable there. Please keep
that property when you add tests.

## Style

* ES modules, `"type": "module"`, 2-space indentation.
* Prefer small pure helpers in `src/config.mjs` over logic buried in the server.
* No `console.log` in the server: stdout carries the protocol. Use the `log()`
  helper, which writes to stderr.

## Submitting a change

1. Fork, branch, and keep the diff focused.
2. Run `npm test`, then `node src/server.mjs --check` against a live Zotero if
   you have one.
3. Describe the *behaviour* you changed, not just the files you touched.

## Reporting a bug

Open an issue with your operating system, Node version, Zotero version, the
exact configuration you used, and the stderr output of the server. Never paste
an API key.
