import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Regression: OpenCode free-lane 429s must not poison egress cooldown state.
// Bun-only transport means upstream 429 is returned/retried by transport logic,
// but egress cooldown cache must never block subsequent requests locally.

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

describe("opencode free lane: 429 must not cool the egress", () => {
  it("leaves the egress healthy when Bun transport returns 429", async () => {
    mocks.transportFetch.mockResolvedValue(rateLimited());

    const result = await new OpenCodeExecutor().execute(executorArgs());

    expect(result.response.status).toBe(429);
    const id = egress.identifyFixedEgress(`https://opencode.ai/x`, PROXY)?.id;
    expect(egress.getEgressCooldown(id)).toBeNull();
  });

  it("a following request still reaches upstream instead of a cached local 429", async () => {
    mocks.transportFetch
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(accepted());

    const ex = new OpenCodeExecutor();
    const first = await ex.execute(executorArgs());
    expect(first.response.status).toBe(429);

    const second = await ex.execute(executorArgs());

    expect(second.response.status).toBe(200);
    expect(mocks.transportFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("does not cool the egress even when Bun sidecar keeps answering 429", async () => {
    mocks.transportFetch.mockResolvedValue(rateLimited());

    const result = await new OpenCodeExecutor().execute(executorArgs());

    expect(result.response.status).toBe(429);
    const id = egress.identifyFixedEgress(`https://opencode.ai/x`, PROXY)?.id;
    expect(egress.getEgressCooldown(id)).toBeNull();
  });
});
