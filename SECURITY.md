# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
*Report a vulnerability* feature on the repository's **Security** tab, or email
the maintainer listed in `package.json`. You can expect an initial reply within
a few days.

## Design and threat model

`zotero-harness-bridge` runs as a local stdio child process of an MCP client and
talks to one HTTP endpoint that you configure.

* **Read-only.** No tool writes to the Zotero library, deletes anything or
  uploads a file.
* **No outbound network beyond your configuration.** The only host contacted is
  the one in `ZOTERO_API_BASE`, which defaults to `127.0.0.1:23119`. Nothing
  is phoned home, and there is no telemetry.
* **No subprocesses.** The server never spawns another program and never
  executes user input as code.
* **No file system writes.** Configuration is read from the environment; nothing
  is cached to disk.
* **Credentials.** `ZOTERO_API_KEY` is read from the environment and sent only as
  the `Zotero-API-Key` header to the configured API base. It is never logged. If
  you use the local API, do not set it at all.
* **Local API exposure.** Enabling Zotero's local API opens a loopback-only HTTP
  port to any process on your machine. That is Zotero's own design and is not
  changed by this project; the setting lives in Zotero, and you can turn it off
  again at any time.

## What is out of scope

* Vulnerabilities in Zotero itself — report those to the Zotero project.
* Anything that requires an attacker to already have code execution on your
  machine.
* Prompt-injection content inside your own library (for example a malicious PDF
  whose text tries to instruct the model). Treat library text as untrusted data.
