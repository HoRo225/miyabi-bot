import {
  parseModelCatalogPage,
  parseOpenAiChatResponseText,
  parseToolCalls,
  type AiProviderMessage,
  type AiProviderTool,
  type AiProviderToolCall,
  type AiModelOption
} from "./ai-provider.js";
import type { Config } from "./config.js";

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
const MAX_MODEL_CATALOG_PAGES = 100;
const CANARY_PROMPT = "Reply with OK.";

function openAiBaseUrl(value: string): string {
  const baseUrl = value.replace(/\/+$/, "");
  return !baseUrl || baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
}

type AiSettingsStore = {
  setting(key: string): string | undefined;
};

type AiProviderResult = {
  content: string;
  modelAlias: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type AiProviderTurnResult = AiProviderResult & {
  toolCalls: AiProviderToolCall[];
};

class AiServiceError extends Error {
  constructor(
    readonly userCode: string,
    readonly logType: string,
    message: string
  ) {
    super(message);
  }
}

export async function fetchAiModelOptions(
  config: Pick<Config, "aiBaseUrl" | "aiApiKey">,
  maxPages = MAX_MODEL_CATALOG_PAGES
): Promise<AiModelOption[]> {
  const normalizedBaseUrl = openAiBaseUrl(config.aiBaseUrl);
  const firstUrl = `${normalizedBaseUrl}/models`;
  const providerOrigin = providerUrlOrigin(firstUrl);
  const seenUrls = new Set<string>();
  const options = new Map<string, AiModelOption>();
  let pageUrl = firstUrl;
  for (let page = 0; page < maxPages; page += 1) {
    if (seenUrls.has(pageUrl)) throw new Error("AI models response returned invalid pagination");
    seenUrls.add(pageUrl);
    const response = await fetch(pageUrl, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.aiApiKey}`
      },
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) throw new Error(`AI models request failed: HTTP ${response.status}`);
    let body: unknown;
    try {
      body = JSON.parse(await readProviderResponseText(response));
    } catch (error) {
      if (error instanceof AiServiceError) throw error;
      throw new Error("AI models request returned an invalid response");
    }
    const catalogPage = parseModelCatalogPage(body);
    for (const option of catalogPage.options) {
      if (!options.has(option.value)) options.set(option.value, option);
    }

    let next = catalogPage.nextUrl;
    if (!next && catalogPage.nextCursor) {
      const cursorUrl = new URL(pageUrl);
      cursorUrl.searchParams.set("cursor", catalogPage.nextCursor);
      next = cursorUrl.toString();
    }
    if (!next) {
      if (catalogPage.hasMore === true) throw catalogIncompleteFailure();
      return [...options.values()];
    }
    pageUrl = resolveModelCatalogNextUrl(next, pageUrl, providerOrigin);
  }
  throw catalogIncompleteFailure();
}

export async function canaryAiModel(
  config: Pick<Config, "aiBaseUrl" | "aiApiKey">,
  candidateModel: string
): Promise<void> {
  const model = candidateModel.trim();
  if (!config.aiApiKey.trim() || !model || model.length > 100) throw canaryFailure();
  let response: Response;
  try {
    response = await fetch(`${openAiBaseUrl(config.aiBaseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.aiApiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: CANARY_PROMPT }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw canaryFailure();
  }
  if (!response.ok) throw canaryFailure();
  try {
    const json = parseOpenAiChatResponseText(
      await readProviderResponseText(response),
      response.headers.get("content-type") ?? ""
    );
    const message = json.choices?.[0]?.message;
    const content = typeof message?.content === "string" ? message.content : "";
    if (!content.trim() && !parseToolCalls(message?.tool_calls).length) throw canaryFailure();
  } catch (error) {
    if (error instanceof AiServiceError && error.logType === "ai_model_canary_failed") throw error;
    throw canaryFailure();
  }
}

function providerUrlOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

function resolveModelCatalogNextUrl(next: string, current: string, providerOrigin: string): string {
  let resolved: URL;
  try {
    resolved = new URL(next, current);
  } catch {
    throw new Error("AI models response returned invalid pagination");
  }
  if (
    !providerOrigin
    || resolved.origin !== providerOrigin
    || (resolved.protocol !== "http:" && resolved.protocol !== "https:")
    || resolved.username
    || resolved.password
  ) {
    throw new Error("AI models response returned unsafe pagination");
  }
  return resolved.toString();
}

function canaryFailure(): AiServiceError {
  return new AiServiceError("AI-PROVIDER-001", "ai_model_canary_failed", "AI model canary failed");
}

function catalogIncompleteFailure(): AiServiceError {
  return new AiServiceError("AI-PROVIDER-001", "ai_model_catalog_incomplete", "AI model catalog is incomplete");
}

export async function callAiProvider(store: AiSettingsStore, config: Config, messages: AiProviderMessage[]): Promise<AiProviderResult> {
  const result = await callAiProviderTurn(store, config, messages);
  if (!result.content.trim()) {
    throw new AiServiceError("AI-LLM-001", "empty_llm_response", "LLM returned empty content");
  }
  return result;
}

export async function callAiProviderTurn(
  store: AiSettingsStore,
  config: Config,
  messages: AiProviderMessage[],
  tools: AiProviderTool[] = []
): Promise<AiProviderTurnResult> {
  const model = store.setting("ai_model")?.trim() || config.aiModel.trim() || "gemini/gemini-3.6-flash";
  const baseUrl = openAiBaseUrl(config.aiBaseUrl);
  const apiKey = config.aiApiKey;
  if (!apiKey) {
    throw new AiServiceError("AI-PROVIDER-001", "missing_ai_api_key", "AI provider API key is missing");
  }
  if (!model) {
    throw new AiServiceError("AI-PROVIDER-001", "missing_ai_model", "AI provider model is missing");
  }
  if (isNonEmptyAssistantPrefill(messages)) {
    throw new AiServiceError("AI-LLM-002", "assistant_prefill_not_allowed", "Assistant prefill is not allowed");
  }

  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 2_000,
        ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: false } : {})
      }),
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new AiServiceError("AI-PROVIDER-001", "ai_provider_request_failed", "AI provider request failed");
  }

  if (!response.ok) {
    throw new AiServiceError("AI-PROVIDER-001", `ai_provider_http_${response.status}`, `AI provider returned HTTP ${response.status}`);
  }

  let json: ReturnType<typeof parseOpenAiChatResponseText>;
  try {
    const body = await readProviderResponseText(response);
    json = parseOpenAiChatResponseText(body, response.headers.get("content-type") ?? "");
  } catch (error) {
    if (error instanceof AiServiceError) throw error;
    throw new AiServiceError("AI-PROVIDER-001", "ai_provider_invalid_response", "AI provider returned an invalid response");
  }
  const message = json.choices?.[0]?.message;
  const content = typeof message?.content === "string" ? message.content : "";
  const toolCalls = parseToolCalls(message?.tool_calls);
  if (!content.trim() && !toolCalls.length) {
    throw new AiServiceError("AI-LLM-001", "empty_llm_response", "LLM returned empty content");
  }

  return {
    content,
    toolCalls,
    modelAlias: model,
    latencyMs: Date.now() - started,
    inputTokens: numberOrUndefined(json.usage?.prompt_tokens),
    outputTokens: numberOrUndefined(json.usage?.completion_tokens)
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isNonEmptyAssistantPrefill(messages: AiProviderMessage[]): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const hasToolCalls = Boolean(message.tool_calls?.length);
    const hasContent = typeof message.content === "string"
      ? message.content.trim().length > 0
      : Array.isArray(message.content) && message.content.some((part) =>
        part.type === "text" ? part.text.trim().length > 0 : true
      );
    if (!hasContent && !hasToolCalls) continue;
    return message.role === "assistant";
  }
  return false;
}

export function aiError(error: unknown): AiServiceError {
  if (error instanceof AiServiceError) return error;
  return new AiServiceError("AI-PROVIDER-001", "ai_provider_unknown_error", "AI provider request failed");
}

async function readProviderResponseText(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new AiServiceError("AI-PROVIDER-001", "ai_provider_body_too_large", "AI provider response exceeded 1 MiB");
  }

  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_PROVIDER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AiServiceError("AI-PROVIDER-001", "ai_provider_body_too_large", "AI provider response exceeded 1 MiB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}
