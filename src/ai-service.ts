import {
  parseModelOptionsFromModelsResponse,
  parseOpenAiChatResponseText,
  parseOpenAiEmbeddingsResponse,
  parseToolCalls,
  type AiProviderMessage,
  type AiProviderTool,
  type AiProviderToolCall,
  type AiModelOption
} from "./ai-provider.js";
import type { Config } from "./config.js";

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;

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

export function embeddingProviderConfig(config: Config): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = openAiBaseUrl(config.aiBaseUrl);
  const apiKey = config.aiApiKey;
  const model = config.aiEmbeddingModel;
  if (!apiKey) throw new AiServiceError("AI-PROVIDER-001", "missing_ai_api_key", "AI provider API key is missing");
  if (!model) throw new AiServiceError("AI-PROVIDER-001", "missing_ai_embedding_model", "AI embedding model is missing");
  return { baseUrl, apiKey, model };
}

export function embeddingDocumentText(text: string): string {
  return `title: discord message | text: ${text.replace(/\s+/g, " ").trim().slice(0, 12_000)}`;
}

export function embeddingQueryText(text: string): string {
  return `task: question answering | query: ${text.replace(/\s+/g, " ").trim().slice(0, 2_000)}`;
}

export async function callEmbeddingProvider(config: Config, inputs: string[]): Promise<number[][]> {
  const { baseUrl, apiKey, model } = embeddingProviderConfig(config);
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input: inputs, encoding_format: "float" }),
    signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) {
    throw new AiServiceError("AI-PROVIDER-001", `ai_embedding_http_${response.status}`, `AI embedding provider returned HTTP ${response.status}`);
  }
  try {
    return parseOpenAiEmbeddingsResponse(JSON.parse(await readProviderResponseText(response)));
  } catch (error) {
    if (error instanceof AiServiceError) throw error;
    throw new AiServiceError("AI-PROVIDER-001", "ai_embedding_invalid_response", "AI embedding provider returned an invalid response");
  }
}

export async function fetchAiModelOptions(config: Pick<Config, "aiBaseUrl" | "aiApiKey">): Promise<AiModelOption[]> {
  const normalizedBaseUrl = openAiBaseUrl(config.aiBaseUrl);
  const response = await fetch(`${normalizedBaseUrl}/models`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.aiApiKey}`
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`AI models request failed: HTTP ${response.status}`);
  try {
    return parseModelOptionsFromModelsResponse(JSON.parse(await readProviderResponseText(response)));
  } catch (error) {
    if (error instanceof AiServiceError) throw error;
    throw new Error("AI models request returned an invalid response");
  }
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
  const model = store.setting("ai_model") ?? config.aiModel;
  const baseUrl = openAiBaseUrl(config.aiBaseUrl);
  const apiKey = config.aiApiKey;
  if (!apiKey) {
    throw new AiServiceError("AI-PROVIDER-001", "missing_ai_api_key", "AI provider API key is missing");
  }
  if (!model) {
    throw new AiServiceError("AI-PROVIDER-001", "missing_ai_model", "AI provider model is missing");
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
        temperature: 0.2,
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
