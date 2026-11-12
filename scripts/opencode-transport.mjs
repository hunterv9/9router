// Bun sidecar: performs the outbound OpenCode free-lane request so it leaves
// with Bun's TLS ClientHello. The free gate keys on the handshake, so a request
// that passes from this runtime is answered 429 FreeUsageLimitError when the
// same body/headers ride Node's OpenSSL fingerprint.
//
// Started by open-sse/utils/opencodeTransport.js, normally as
//   BUN_BE_BUN=1 <opencode-binary> scripts/opencode-transport.mjs
// because the OpenCode CLI is itself a Bun single-file executable and no
// separate Bun install is required. Prints one JSON line {"port":N} when ready.

const TOKEN = process.env.OPENCODE_TRANSPORT_TOKEN || "";

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  // SSE bodies can sit between chunks; 0 disables the idle timeout.
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return new Response("ok");
    if (pathname !== "/forward") return json({ error: "not found" }, 404);
    if (TOKEN && req.headers.get("x-opencode-transport-token") !== TOKEN) {
      return json({ error: "forbidden" }, 403);
    }

    let payload;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }

    const { url, method, headers, body, proxy } = payload || {};
    if (!url) return json({ error: "url required" }, 400);

    try {
      const init = { method: method || "POST", headers: headers || {} };
      if (typeof body === "string" && body) init.body = Buffer.from(body, "base64");
      // The proxy hop stays inside the Bun transport so the TLS handshake to the
      // upstream still originates here (a NAT'd relay would rewrite headers only).
      if (proxy) init.proxy = proxy;
      const upstream = await fetch(url, init);

      const outHeaders = new Headers();
      upstream.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        // Bun's fetch decodes the body, so length/encoding from upstream no
        // longer describe what the client receives.
        if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") return;
        outHeaders.set(key, value);
      });

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: outHeaders,
      });
    } catch (error) {
      return json(
        { error: error?.message || "transport error", type: "transport_error" },
        502,
        { "x-opencode-transport-error": "1" },
      );
    }
  },
});

console.log(JSON.stringify({ port: server.port }));

const shutdown = () => {
  try { server.stop(true); } catch { /* already stopped */ }
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
