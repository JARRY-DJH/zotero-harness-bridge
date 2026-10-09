/*
 * Shared, side-effect-free configuration helpers for zotero-harness-bridge.
 *
 * Imported by both src/server.mjs (the MCP server) and scripts/setup.mjs (the
 * client-config generator) so the two can never disagree about a default.
 *
 * Nothing in here touches the network, the stdin stream or the process state.
 */

import { readFileSync } from "node:fs";
import process from "node:process";

export const SERVER_NAME = "zotero-harness-bridge";
export const FALLBACK_VERSION = "0.1.0";

/** Zotero 7 ships its local HTTP API on this host/port pair. */
export const DEFAULT_LOCAL_HOST = "127.0.0.1";
export const DEFAULT_LOCAL_PORT = "23119";

export const DEFAULT_TIMEOUT_MS = 30000;

/** Version of the package this module lives in, with a safe fallback. */
export function readVersion() {
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8"));
    if (pkg && typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch (err) {
    /* Running from a copied file outside the package: use the fallback. */
  }
  return FALLBACK_VERSION;
}

function envString(env, name, fallback) {
  const raw = env ? env[name] : undefined;
  if (typeof raw !== "string") return fallback;
  const value = raw.trim();
  return value ? value : fallback;
}

/**
 * Resolve the Zotero API base URL.
 *
 * ZOTERO_API_BASE wins when set. Otherwise the URL is assembled from the
 * local-API host/port and library selectors, so a Zotero installed on a
 * non-default port (or a group library) needs no code change.
 */
export function resolveApiBase(env = process.env) {
  const explicit = envString(env, "ZOTERO_API_BASE", "");
  if (explicit) return explicit.replace(/\/+$/, "");

  const host = envString(env, "ZOTERO_LOCAL_HOST", DEFAULT_LOCAL_HOST);
  const port = envString(env, "ZOTERO_LOCAL_PORT", DEFAULT_LOCAL_PORT);
  const isGroup = envString(env, "ZOTERO_LIBRARY_TYPE", "user").toLowerCase() === "group";
  const id = envString(env, "ZOTERO_LIBRARY_ID", "0");
  return "http://" + host + ":" + port + "/api/" + (isGroup ? "groups" : "users") + "/" + id;
}

export function resolveApiKey(env = process.env) {
  return envString(env, "ZOTERO_API_KEY", "");
}

export function resolveTimeoutMs(env = process.env) {
  const parsed = Number(envString(env, "ZOTERO_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS)));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(parsed);
}

/** Environment block an MCP client should hand to the spawned server. */
export function serverEnv(overrides) {
  const merged = Object.assign({}, overrides);
  const env = {};
  for (const key of Object.keys(merged)) {
    const value = merged[key];
    if (value === undefined || value === null || value === "") continue;
    env[key] = String(value);
  }
  if (!env.ZOTERO_API_BASE) env.ZOTERO_API_BASE = resolveApiBase();
  return env;
}

/**
 * The canonical stdio server description. Every client example in examples/
 * and scripts/setup.mjs is rendered from this one shape.
 */
export function stdioServerConfig(options) {
  const opts = options || {};
  return {
    command: opts.nodePath || process.execPath,
    args: [opts.serverPath],
    env: serverEnv(opts.env),
  };
}
