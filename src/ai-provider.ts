export type JsonSchema = {
  type: "object" | "string" | "number" | "integer" | "boolean" | "array";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: Array<string | number | boolean>;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type AiProviderTextPart = { type: "text"; text: string };
export type AiProviderImagePart = { type: "image_url"; image_url: { url: string } };
export type AiProviderContent = string | Array<AiProviderTextPart | AiProviderImagePart>;

export type AiProviderToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type AiProviderMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: AiProviderContent | null;
  tool_calls?: AiProviderToolCall[];
  tool_call_id?: string;
};

export type AiProviderTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
  };
};

type OpenAiChatResponse = {
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
};


export type AiModelOption = {
  label: string;
  value: string;
};

export type AiModelCatalogPage = {
  options: AiModelOption[];
  nextUrl: string | null;
  nextCursor: string | null;
  hasMore: boolean | null;
};

type OpenAiStreamChunk = {
  choices?: Array<{
    delta?: { content?: unknown; tool_calls?: unknown };
    message?: { content?: unknown; tool_calls?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: OpenAiChatResponse["usage"];
};


export function parseModelOptionsFromModelsResponse(body: unknown): AiModelOption[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const options: AiModelOption[] = [];
  for (const row of data) {
    const id = typeof row === "string" ? row : typeof row === "object" && row !== null ? (row as { id?: unknown }).id : undefined;
    if (typeof id !== "string") continue;
    const value = id.trim();
    if (!value || value.length > 100 || seen.has(value)) continue;

    const name = typeof row === "object" && row !== null ? (row as { name?: unknown }).name : undefined;
    const label = (typeof name === "string" && name.trim() ? name.trim() : value).slice(0, 100);
    seen.add(value);
    options.push({ label, value });
  }
  return options;
}

export function parseModelCatalogPage(body: unknown): AiModelCatalogPage {
  const root = asRecord(body);
  const pagination = asRecord(root?.pagination);
  const meta = asRecord(root?.meta);
  const links = asRecord(root?.links);
  const nextValue = firstString(
    root?.next,
    root?.next_url,
    root?.nextUrl,
    root?.next_page,
    root?.nextPage,
    pagination?.next,
    pagination?.next_url,
    pagination?.nextUrl,
    asRecord(pagination?.next)?.href,
    meta?.next,
    meta?.next_url,
    meta?.nextUrl,
    asRecord(meta?.next)?.href,
    links?.next,
    asRecord(links?.next)?.href,
    asRecord(links?.next)?.url,
    asRecord(root?.next)?.href,
    asRecord(root?.next)?.url
  );
  const nextCursor = firstString(
    root?.next_cursor,
    root?.nextCursor,
    pagination?.next_cursor,
    pagination?.nextCursor,
    meta?.next_cursor,
    meta?.nextCursor
  );
  return {
    options: parseModelOptionsFromModelsResponse(body),
    nextUrl: nextValue,
    nextCursor,
    hasMore: firstBoolean(
      root?.has_more,
      root?.hasMore,
      pagination?.has_more,
      pagination?.hasMore,
      meta?.has_more,
      meta?.hasMore
    )
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function firstBoolean(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

export function parseOpenAiChatResponseText(body: string, contentType = ""): OpenAiChatResponse {
  const trimmed = body.trim();
  if (contentType.includes("text/event-stream") || trimmed.startsWith("data:")) {
    let content = "";
    let usage: OpenAiChatResponse["usage"];
    let finishReason: unknown;
    const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    for (const line of body.split(/\r?\n/)) {
      const trimmedLine = line.trim();
      if (!trimmedLine.startsWith("data:")) continue;
      const data = trimmedLine.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const chunk = JSON.parse(data) as OpenAiStreamChunk;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta?.content;
      const message = choice?.message?.content;
      if (typeof delta === "string") content += delta;
      if (typeof message === "string") content += message;
      appendToolCallDeltas(toolCalls, choice?.delta?.tool_calls);
      appendToolCallDeltas(toolCalls, choice?.message?.tool_calls);
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
      if (chunk.usage) usage = chunk.usage;
    }
    return {
      choices: [{
        message: {
          content,
          tool_calls: normalizedToolCalls(toolCalls)
        },
        finish_reason: finishReason
      }],
      usage
    };
  }
  return JSON.parse(trimmed) as OpenAiChatResponse;
}

function appendToolCallDeltas(target: Map<number, { id: string; name: string; arguments: string }>, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (let fallbackIndex = 0; fallbackIndex < value.length; fallbackIndex += 1) {
    const row = value[fallbackIndex] as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
    if (!row || typeof row !== "object") continue;
    const index = typeof row.index === "number" && Number.isInteger(row.index) ? row.index : fallbackIndex;
    const current = target.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof row.id === "string") current.id += row.id;
    if (typeof row.function?.name === "string") current.name += row.function.name;
    if (typeof row.function?.arguments === "string") current.arguments += row.function.arguments;
    target.set(index, current);
  }
}

function normalizedToolCalls(source: Map<number, { id: string; name: string; arguments: string }>): AiProviderToolCall[] | undefined {
  const calls = [...source.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, value]) => ({
      id: value.id || `call_${index}`,
      type: "function" as const,
      function: {
        name: value.name,
        arguments: value.arguments || "{}"
      }
    }))
    .filter((call) => call.function.name);
  return calls.length ? calls : undefined;
}

export function parseToolCalls(value: unknown): AiProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: AiProviderToolCall[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index] as { id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } } | null;
    const name = row?.function?.name;
    const args = row?.function?.arguments;
    if (typeof name !== "string" || !name.trim()) continue;
    calls.push({
      id: typeof row?.id === "string" && row.id ? row.id : `call_${index}`,
      type: "function",
      function: {
        name: name.trim(),
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {})
      }
    });
  }
  return calls;
}
