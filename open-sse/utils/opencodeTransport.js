// Node-side manager for the Bun transport sidecar (scripts/opencode-transport.mjs).
//
// The OpenCode free gate keys on the TLS ClientHello: the same request that
// passes from Bun's BoringSSL fetch is answered 429 FreeUsageLimitError when it
// rides Node's OpenSSL fingerprint. wreq-js can match a cipher list but not the
// rest of Bun's ClientHello, so the request is handed to a Bun process instead.
//
// The OpenCode CLI is a Bun single-file executable, so `BUN_BE_BUN=1 <opencode>`
// runs it as the plain `bun` CLI — no separate Bun install needed. The sidecar
// starts lazily on the first free-lane request and is reused thereafter. Every
// failure (missing runtime, spawn error, forward error) is reported as
// OpencodeTransportUnavailableError so the executor can fall back to its own
// transports instead of failing the request.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const START_TIMEOUT_MS = 10000;
const UNAVAILABLE_RECHECK_MS = 5 * 60 * 1000;

export class OpencodeTransportUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpencodeTransportUnavailableError";
  }
}

// Kept on globalThis so a dev-server module reload does not leak a sidecar.
const g = globalThis;
const store = g.__ninrouterOpencodeTransport
  || (g.__ninrouterOpencodeTransport = { state: null, starting: null, unavailableUntil: 0, lastError: "" });
// Every child this module ever spawned, so a failed forward can retire the one it
// used without leaking the process (each orphan keeps ~27MB and a Bun event loop).
if (!store.children) store.children = new Set();

export function isOpencodeTransportEnabled() {
  const v = String(process.env.OPENCODE_TRANSPORT || "").trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "disabled" || v === "no");
}

function findOnPath(name) {
  const raw = process.env.PATH || "";
  for (const dir of raw.split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    if (existsSync(full)) return full;
  }
  return "";
}

// Prefer a real Bun runtime; otherwise fall back to the OpenCode binary, which
// carries Bun internally and switches to the bun CLI under BUN_BE_BUN=1.
function resolveBunBinary() {
  const explicit = process.env.OPENCODE_BUN_BIN;
  if (explicit && existsSync(explicit)) return { bin: explicit, beBun: false };

  const bun = findOnPath(process.platform === "win32" ? "bun.exe" : "bun");
  if (bun) return { bin: bun, beBun: false };

  const candidates = [
    process.env.OPENCODE_BIN,
    path.join(os.homedir(), ".opencode", "bin", "opencode"),
    path.join(os.homedir(), ".local", "bin", "opencode"),
    "/root/.opencode/bin/opencode",
    "/usr/local/bin/opencode",
    "/usr/bin/opencode",
    findOnPath(process.platform === "win32" ? "opencode.exe" : "opencode"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { bin: candidate, beBun: true };
  }
  return { bin: "", beBun: false };
}

function resolveScriptPath() {
  const explicit = process.env.OPENCODE_TRANSPORT_SCRIPT;
  if (explicit && existsSync(explicit)) return explicit;

  const candidates = [];
  if (process.cwd()) candidates.push(path.join(process.cwd(), "scripts", "opencode-transport.mjs"));
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, "..", "..", "scripts", "opencode-transport.mjs"));
  } catch { /* import.meta unavailable */ }
  return candidates.find((candidate) => candidate && existsSync(candidate)) || "";
}

function ensureStarted() {
  if (store.state) return Promise.resolve(store.state);
  if (store.starting) return store.starting;
  if (!isOpencodeTransportEnabled()) {
    return Promise.reject(new OpencodeTransportUnavailableError("transport disabled"));
  }
  if (store.unavailableUntil > Date.now()) {
    return Promise.reject(new OpencodeTransportUnavailableError(store.lastError || "transport unavailable"));
  }

  const script = resolveScriptPath();
  const { bin, beBun } = resolveBunBinary();
  if (!bin || !script) {
    store.unavailableUntil = Date.now() + UNAVAILABLE_RECHECK_MS;
    store.lastError = "Bun/OpenCode binary or sidecar script not found";
    return Promise.reject(new OpencodeTransportUnavailableError(store.lastError));
  }

  const token = crypto.randomBytes(24).toString("hex");
  store.starting = new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(bin, [script], {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        OPENCODE_TRANSPORT_TOKEN: token,
        ...(beBun ? { BUN_BE_BUN: "1" } : {}),
      },
    });

    store.children.add(child);
    child.on("close", () => store.children.delete(child));

    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      store.starting = null;
      store.lastError = message;
      store.unavailableUntil = Date.now() + UNAVAILABLE_RECHECK_MS;
      try { child.kill(); } catch { /* already gone */ }
      store.children.delete(child);
      reject(new OpencodeTransportUnavailableError(message));
    };

    const timer = setTimeout(() => fail("sidecar start timeout"), START_TIMEOUT_MS);

    let buffer = "";
    child.stdout?.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/\{"port":\s*\d+\}/);
      if (!match) return;
      let port = 0;
      try { port = JSON.parse(match[0]).port; } catch { port = 0; }
      if (!port || settled) return;
      settled = true;
      clearTimeout(timer);
      store.starting = null;
      store.state = { port, token, child };
      resolve(store.state);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) store.lastError = text.slice(0, 500);
    });
    child.on("error", (error) => fail(error.message));
    child.on("exit", (code) => {
      store.state = null;
      fail(`sidecar exited with code ${code}`);
    });
  });

  return store.starting;
}

/** Stop the sidecar(s); the next request starts a fresh one. */
export function stopOpencodeTransport() {
  for (const child of store.children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  store.children.clear();
  store.state = null;
}

if (typeof process !== "undefined" && typeof process.once === "function") {
  process.once("exit", stopOpencodeTransport);
}

/**
 * Forward one request through the Bun sidecar and return its Response.
 *
 * @param {string} url
 * @param {{method?: string, headers?: object, body?: string, signal?: AbortSignal}} init
 * @param {{proxyUrl?: string}} [options]
 * @returns {Promise<Response>}
 */
export async function opencodeTransportFetch(url, init = {}, { proxyUrl = "" } = {}) {
  const state = await ensureStarted();

  const payload = {
    url,
    method: init.method || "POST",
    headers: init.headers || {},
    body: typeof init.body === "string" && init.body ? Buffer.from(init.body).toString("base64") : undefined,
    proxy: proxyUrl || undefined,
  };

  let response;
  try {
    response = await fetch(`http://127.0.0.1:${state.port}/forward`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-transport-token": state.token },
      body: JSON.stringify(payload),
      signal: init.signal,
    });
  } catch (error) {
    // The port may still be listening while the sidecar is wedged, or the child
    // may have died without the exit handler firing yet. Retire the child (do not
    // just drop the state — that orphaned the process) and let the next request
    // spawn a fresh sidecar instead of reusing a dead one.
    if (store.state === state) {
      try { state.child?.kill(); } catch { /* already gone */ }
      store.children.delete(state.child);
      store.state = null;
    }
    throw new OpencodeTransportUnavailableError(`sidecar forward failed: ${error?.message || error}`);
  }

  // A transport_error means the sidecar reached no upstream (bad proxy, TLS
  // failure); hand back to the caller's fallback rather than surface a 502.
  if (response.status === 502 && response.headers.get("x-opencode-transport-error") === "1") {
    const text = await response.text().catch(() => "");
    throw new OpencodeTransportUnavailableError(`sidecar transport error: ${text.slice(0, 200)}`);
  }

  return response;
}

export const __test__ = { resolveBunBinary, resolveScriptPath, ensureStarted, store };
