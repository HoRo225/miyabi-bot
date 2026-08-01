import {
  shouldUseWebSearch,
  type IntentRoute
} from "./ai-routing.js";

export type WebSearchResult = {
  query: string;
  results: Array<{
    title: string;
    url: string;
    content: string;
  }>;
  error?: string;
};

type WebSearchConfig = {
  searxngBaseUrl: string;
};

function webSearchQuery(question: string): string {
  return question.replace(/\s+/g, " ").trim().slice(0, 400);
}

export async function webSearchForQuestion(config: WebSearchConfig, question: string, route?: IntentRoute): Promise<WebSearchResult | undefined> {
  if (!(route ? route.useWebSearch : shouldUseWebSearch(question))) return undefined;
  const query = webSearchQuery(question);
  if (!query) return undefined;
  try {
    return await fetchSearxngResults(config.searxngBaseUrl, query);
  } catch (error) {
    return {
      query,
      results: [],
      error: error instanceof Error ? error.message.slice(0, 200) : "search_failed"
    };
  }
}

async function fetchSearxngResults(baseUrl: string, query: string): Promise<WebSearchResult> {
  const url = new URL("search", `${baseUrl.replace(/\/+$/, "")}/`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("language", "zh-TW");
  url.searchParams.set("safesearch", "1");
  url.searchParams.set("engines", "duckduckgo,startpage");

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-real-ip": "127.0.0.1",
      "user-agent": "horo-discord-bot/0.1"
    },
    signal: AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`SearXNG HTTP ${response.status}`);
  return parseSearxngSearchResponse(await response.json(), query);
}

export function parseSearxngSearchResponse(body: unknown, query: string): WebSearchResult {
  const rows = (body as { results?: unknown } | null)?.results;
  if (!Array.isArray(rows)) return { query, results: [] };

  const seen = new Set<string>();
  const results: WebSearchResult["results"] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const item = row as { title?: unknown; url?: unknown; content?: unknown };
    if (typeof item.url !== "string" || !item.url.trim() || seen.has(item.url)) continue;
    seen.add(item.url);
    const title = typeof item.title === "string" && item.title.trim() ? item.title.trim() : item.url;
    const content = typeof item.content === "string" ? item.content.replace(/\s+/g, " ").trim() : "";
    results.push({
      title: title.slice(0, 160),
      url: item.url,
      content: content.slice(0, 500)
    });
    if (results.length >= 5) break;
  }
  return { query, results };
}
