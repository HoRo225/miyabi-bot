import assert from "node:assert/strict";
import test from "node:test";
import { parseModelOptionsFromModelsResponse } from "./ai-provider.js";
import { aiError, canaryAiModel, fetchAiModelOptions } from "./ai-service.js";

const providerConfig = {
  aiBaseUrl: "https://provider.example",
  aiApiKey: "api-secret"
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("model parser keeps every valid option beyond 200", () => {
  const options = parseModelOptionsFromModelsResponse({
    data: Array.from({ length: 205 }, (_, index) => ({ id: `model-${index}` }))
  });
  assert.equal(options.length, 205);
  assert.equal(options.at(-1)?.value, "model-204");
});

test("model catalog follows same-origin pagination and merges all pages", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (requestedUrls.length === 1) {
        return jsonResponse({
          data: [{ id: "model-a" }],
          has_more: true,
          next: "/v1/models?cursor=page-2"
        });
      }
      return jsonResponse({ data: [{ id: "model-b" }, { id: "model-a" }] });
    }) as typeof fetch;

    const options = await fetchAiModelOptions(providerConfig);
    assert.deepEqual(options.map((option) => option.value), ["model-a", "model-b"]);
    assert.deepEqual(requestedUrls, [
      "https://provider.example/v1/models",
      "https://provider.example/v1/models?cursor=page-2"
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalog follows cursor metadata when no next URL is present", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      return requestedUrls.length === 1
        ? jsonResponse({ data: [{ id: "model-a" }], pagination: { has_more: true, next_cursor: "page-2" } })
        : jsonResponse({ data: [{ id: "model-b" }] });
    }) as typeof fetch;

    const options = await fetchAiModelOptions(providerConfig);
    assert.deepEqual(options.map((option) => option.value), ["model-a", "model-b"]);
    assert.equal(requestedUrls[1], "https://provider.example/v1/models?cursor=page-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("model catalog rejects explicit has-more without a safe pointer", async () => {
  const originalFetch = globalThis.fetch;
  const cases: unknown[] = [
    { data: [{ id: "root-underscore" }], has_more: true },
    { data: [{ id: "root-camel" }], hasMore: true },
    { data: [{ id: "meta-underscore" }], meta: { has_more: true } },
    { data: [{ id: "meta-camel" }], meta: { hasMore: true } },
    { data: [{ id: "pagination-underscore" }], pagination: { has_more: true } },
    { data: [{ id: "pagination-camel" }], pagination: { hasMore: true } }
  ];
  try {
    for (const body of cases) {
      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return jsonResponse(body);
      }) as typeof fetch;

      await assert.rejects(
        () => fetchAiModelOptions(providerConfig),
        (error: unknown) => {
          const normalized = aiError(error);
          assert.equal(normalized.userCode, "AI-PROVIDER-001");
          assert.equal(normalized.logType, "ai_model_catalog_incomplete");
          return true;
        }
      );
      assert.equal(fetchCount, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalog treats explicit false or absent has-more as terminal", async () => {
  const originalFetch = globalThis.fetch;
  const cases: Array<{ body: unknown; value: string }> = [
    { body: { data: [{ id: "absent" }] }, value: "absent" },
    { body: { data: [{ id: "root-underscore" }], has_more: false }, value: "root-underscore" },
    { body: { data: [{ id: "root-camel" }], hasMore: false }, value: "root-camel" },
    { body: { data: [{ id: "meta-underscore" }], meta: { has_more: false } }, value: "meta-underscore" },
    { body: { data: [{ id: "pagination-camel" }], pagination: { hasMore: false } }, value: "pagination-camel" }
  ];
  try {
    for (const { body, value } of cases) {
      let fetchCount = 0;
      globalThis.fetch = (async () => {
        fetchCount += 1;
        return jsonResponse(body);
      }) as typeof fetch;

      const options = await fetchAiModelOptions(providerConfig);
      assert.deepEqual(options.map((option) => option.value), [value]);
      assert.equal(fetchCount, 1);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalog rejects cross-origin pagination links", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return jsonResponse({ data: [{ id: "model-a" }], next: "https://evil.example/models" });
    }) as typeof fetch;

    await assert.rejects(
      () => fetchAiModelOptions(providerConfig),
      /unsafe pagination/
    );
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("model catalog cap reports a fixed incomplete error instead of truncating", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return jsonResponse({ data: [{ id: "model-a" }], next: "/v1/models?cursor=next" });
    }) as typeof fetch;

    await assert.rejects(
      () => fetchAiModelOptions(providerConfig, 1),
      (error: unknown) => {
        const normalized = aiError(error);
        assert.equal(normalized.userCode, "AI-PROVIDER-001");
        assert.equal(normalized.logType, "ai_model_catalog_incomplete");
        return true;
      }
    );
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("candidate canary uses fixed server content, 30s request, and no sampling", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestInit: RequestInit | undefined;
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(input);
      requestInit = init;
      return jsonResponse({ choices: [{ message: { content: "OK" } }] });
    }) as typeof fetch;

    await canaryAiModel(providerConfig, "candidate-model");
    assert.equal(requestedUrl, "https://provider.example/v1/chat/completions");
    assert.ok(requestInit?.signal);
    const body = JSON.parse(String(requestInit?.body)) as Record<string, unknown>;
    assert.deepEqual(body, {
      model: "candidate-model",
      messages: [{ role: "user", content: "Reply with OK." }],
      max_tokens: 1
    });
    assert.doesNotMatch(String(requestInit?.body), /api-secret|discord/);
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get("authorization"), "Bearer api-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("candidate canary reports one fixed failure without fallback or retry", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  try {
    globalThis.fetch = (async () => {
      fetchCount += 1;
      return new Response("provider-secret-body", { status: 503 });
    }) as typeof fetch;

    await assert.rejects(
      () => canaryAiModel(providerConfig, "candidate-model"),
      (error: unknown) => {
        const normalized = aiError(error);
        assert.equal(normalized.userCode, "AI-PROVIDER-001");
        assert.equal(normalized.logType, "ai_model_canary_failed");
        assert.doesNotMatch(normalized.message, /provider-secret-body/);
        return true;
      }
    );
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
