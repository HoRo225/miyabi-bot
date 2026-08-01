export type PromptMessageRef = {
  id: string;
  channelId?: string;
  authorId: string;
  authorName: string | null;
  content: string;
  createdAt: string;
  url: string;
  attachments?: string[];
  imageUrls?: string[];
  attachmentExtractions?: string[];
};

export type MemorySearchResult = {
  query: string;
  hits: PromptMessageRef[];
  contextMessages: PromptMessageRef[];
  sources: string[];
};

export function promptSource(message: PromptMessageRef): string {
  return `<#${message.channelId ?? "unknown"}> / ${message.authorName ?? message.authorId} / ${message.createdAt} / ${message.url}`;
}

export function canRememberInChannel(channelId: string, memoryChannelIds: Set<string>): boolean {
  return memoryChannelIds.has(channelId);
}

export function selectedIdChanges(existingIds: string[], selectedIds: string[]): { add: string[]; remove: string[] } {
  const selected = new Set(selectedIds);
  const existing = new Set(existingIds);
  return {
    add: selectedIds.filter((id) => !existing.has(id)),
    remove: existingIds.filter((id) => !selected.has(id))
  };
}

export function ftsQueryFromText(text: string): string | undefined {
  const terms: string[] = [];
  for (const match of text.matchAll(/\p{Script=Han}{3,}|[\p{L}\p{N}_]{3,}/gu)) {
    const value = match[0].slice(0, 64);
    if (/^\p{Script=Han}+$/u.test(value)) {
      for (let index = 0; index <= value.length - 3; index += 1) terms.push(value.slice(index, index + 3));
    } else {
      terms.push(value);
    }
  }
  const uniqueTerms = [...new Set(terms)].slice(0, 8);
  if (!uniqueTerms.length) return undefined;
  return uniqueTerms.map((term) => `"${term.replaceAll("\"", "\"\"")}"`).join(" OR ");
}

export function twoCharacterHanTerms(text: string): string[] {
  return [...new Set([...text.matchAll(/(?<!\p{Script=Han})(\p{Script=Han}{2})(?!\p{Script=Han})/gu)].map((match) => match[1]))].slice(0, 8);
}

export function cosineSimilarity(left: number[], right: number[]): number | undefined {
  if (!left.length || left.length !== right.length) return undefined;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return undefined;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function parseEmbeddingJson(value: unknown): number[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "number" && Number.isFinite(item)) ? parsed : [];
  } catch {
    return [];
  }
}

export function uniquePromptRefs(messages: PromptMessageRef[]): PromptMessageRef[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export function boundedContextMessages(context: PromptMessageRef[], hits: PromptMessageRef[], limit: number): PromptMessageRef[] {
  const selected = context.slice(0, limit);
  for (const hit of hits.slice(0, limit)) {
    if (selected.some((message) => message.id === hit.id)) continue;
    const replaceAt = selected.findLastIndex((message) => !hits.some((candidate) => candidate.id === message.id));
    if (replaceAt < 0) break;
    selected[replaceAt] = hit;
  }
  return selected.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
