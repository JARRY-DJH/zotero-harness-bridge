# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Planned

- Optional localisation of the model-facing strings (the server currently speaks
  English to the model, whatever language your library is in).
- Read/write tools, if Zotero's local API grows a stable write path.

## [0.1.0] - 2026-10-09

First public release. Derived from a private, machine-specific DSH bundle that
only ran on one computer.

### Added

- Zero-dependency MCP stdio server for the Zotero local API and the Zotero Web
  API (`src/server.mjs`), exposing nine read tools, a connection self-check and
  two MCP resources.
- Machine-independent configuration layer (`src/config.mjs`): every path and URL
  is auto-detected or supplied through an environment variable, and every one of
  them has a portable default.
- CLI on the server binary: `--help`, `--version`, `--check` (with `--json`) and
  `--print-config`.
- `scripts/setup.mjs`, which detects this machine's node binary and server path
  and prints ready-to-paste client configuration, including DSH's
  `cordis.patch.yml` block.
- `examples/` with a DSH patch template and a generic MCP JSON snippet, both
  using placeholders instead of hard-coded paths.
- Test suite that needs no Zotero: `test/mock-zotero.mjs` stands in for the
  local API and `test/server.test.mjs` drives the real server process over real
  stdio. The suite covers every tool, the resource surface, the JSON-RPC error
  paths, all CLI modes, the configuration defaults and a few hygiene rules.
- GitHub Actions CI on Linux, Windows and macOS across Node 18, 20 and 22.
- MIT licence, contributing guide, security policy and this changelog.

### Removed

- Machine-specific absolute paths from configuration and documentation.
- Development scratch that had accumulated in the private copy: backup
  directories, captured `*.jsonl` protocol transcripts, server stderr logs, the
  asar extraction helper and the extracted third-party `vendor/` bundle.
