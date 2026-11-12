import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression: a 429 answered over the wreq/native handshake is the free lane's
// TLS gate, not a quota refusal for that IP. Cooling the egress on it locked a
// healthy proxy out for the full 30-minute cooldown, so every later request was
// answered from the cache ("no alternate — local 429") until the timer expired.

const mocks = vi.hoisted(() => {
  class OpencodeTransportUnavailableError extends Error { }
  class OpencodeTlsUnavailableError extends Error { }
  return {
    opencodeTlsFetch: vi.fn(),
    transportFetch: vi.fn(),
    proxyAwareFetch: vi.fn(),
    OpencodeTransportUnavailableError,
    OpencodeTlsUnavailableError,
  };
});

vi.mock("../../open-sse/services/opencodeTlsClient.js", () => ({
  opencodeTlsFetch: mocks.opencodeTlsFetch,
  OpencodeTlsUnavailableError: mocks.OpencodeTlsUnavailableError,
  resetOpencodeTlsSession: () => { },
}));

vi.mock("../../open-sse/utils/opencodeTransport.js", () => ({
  isOpencodeTransportEnabled: () => true,
  opencodeTransportFetch: mocks.transportFetch,
  OpencodeTransportUnavailableError: mocks.OpencodeTransportUnavailableError,
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: mocks.proxyAwareFetch,
}));

const egress = await import("../../open-sse/utils/egress.js");
const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");

const PROXY = {
  connectionProxyEnabled: true,
  connectionProxyUrl: "http://user:pass@100.96.0.20:8080",
  connectionNoProxy: "",
  vercelRelayUrl: "",
  strictProxy: false,
};

const MODEL = "mimo-v2.6-flash-free";

function rateLimited() {
  return new Response(
    JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "limit" } }),
    { status: 429, headers: { "retry-after": "76873" } }
  );
}

function accepted() {
  return new Response("data: {}\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}

function executorArgs() {
  return {
    model: MODEL,
    body: { model: MODEL, messages: [{ role: "user", content: "hi" }], stream: true },
    stream: true,
    credentials: { apiKey: "", connectionId: "conn-1" },
    proxyOptions: { ...PROXY },
    log: { warn: () => { }, debug: () => { }, info: () => { } },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Each test starts with a clean cooldown table.
  const ip = "203.0.113.7";
  egress.clearEgressCooldown(`direct:${ip}`);
  egress.clearEgressCooldown(
    egress.identifyFixedEgress(`https://opencode.ai/x`, PROXY)?.id
  );
});

afterEach(() => {
  const id = egress.identifyFixedEgress(`https://opencode.ai/x`, PROXY)?.id;
  if (id) egress.clearEgressCooldown(id);
});

describe("opencode free lane: TLS-gate 429 must not cool the egress", () => {
  it("leaves the egress healthy when the 429 came from the wreq transport", async () => {
    mocks.transportFetch.mockRejectedValue(new mocks.OpencodeTransportUnavailableError("sidecar down"));
    mocks.opencodeTlsFetch.mockResolvedValue(rateLimited());

    const result = await new OpenCodeExecutor().execute(executorArgs());

    expect(result.response.status).toBe(429);
    const id = egress.identifyFixedEgress(`https://opencode.ai/x`, PROXY)?.id;
    expect(egress.getEgressCooldown(id)).toBeNull();
  });

  it("a following request still reaches upstream instead of a cached local 429", async () => {
    mocks.transportFetch.mockRejectedValue(new mocks.OpencodeTransportUnavailableError("sidecar down"));
    mocks.opencodeTlsFetch.mockResolvedValue(rateLimited());

    const ex = new OpenCodeExecutor();
    await ex.execute(executorArgs());

    // Transport recovers: the lane must be usable immediately, not 30 minutes later.
    mocks.transportFetch.mockReset();
    mocks.transportFetch.mockResolvedValue(accepted());
    const second = await ex.execute(executorArgs());

    expect(second.response.status).toBe(200);
    expect(mocks.transportFetch).toHaveBeenCalledTimes(1);
  });

  it("still cools the egress when the Bun sidecar itself answers 429", async () => {
    mocks.transportFetch.mockResolvedValue(rateLimited());

    const result = await new OpenCodeExecutor().execute(executorArgs());

    expect(result.response.status).toBe(429);
    const id = egress.identifyFixedEgress(`https://opencode.ai/x`, PROXY)?.id;
    expect(egress.getEgressCooldown(id)).not.toBeNull();
  });
});
