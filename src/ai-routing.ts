export type IntentKind = "answer_only" | "memory" | "recent_context" | "web_search" | "ambiguous";

export type IntentRoute = {
  intent: IntentKind;
  useMemory: boolean;
  useRecentContext: boolean;
  useWebSearch: boolean;
  useSpoiler: boolean;
  clarifyingQuestion: string | null;
};

type PromptContent = {
  content: string;
};

export function shouldSearchMemory(question: string): boolean {
  const directMemory = /(歷史|記憶|資料庫|上下文|脈絡|之前|以前|上次|上回|前一次|前幾次|提過|說過|講過|問過|回過|誰說|誰提|誰講|誰問|誰回|哪個頻道|在哪個訊息|哪一則|那一則|這一則|那則|這則|剛剛|剛才|剛才那段|剛剛那個|剛那個|剛[說講問提聊回發]|前面|上面|稍早|對話|討論|聊天|聊什麼|講什麼|說什麼|前文|後續|這串|那串|訊息串|聊天紀錄|context|history|memory|previous|earlier|conversation|discussion|chat|what did we talk about|what was discussed)/i.test(question);
  const summaryMemory = /(摘要|總結|整理|重點|懶人包|summary|summarize).*(對話|討論|聊天|紀錄|聊天紀錄|上下文|脈絡|前文|後續|這串|那串|訊息串|近期|最近|剛剛|剛才|上面|前面|conversation|discussion|chat|context)|(?:對話|討論|聊天|紀錄|聊天紀錄|上下文|脈絡|前文|後續|這串|那串|訊息串|近期|最近|剛剛|剛才|上面|前面|conversation|discussion|chat|context).*(摘要|總結|整理|重點|懶人包|summary|summarize)/i.test(question);
  const searchMemory = /(記憶|歷史|對話|討論|聊天|訊息|上下文|聊天紀錄).*(搜尋|查詢|查一下|找一下|幫我找|找)|(?:搜尋|查詢|查一下|找一下|幫我找|找).*(記憶|歷史|對話|討論|聊天|訊息|上下文|聊天紀錄)/i.test(question);
  return directMemory || summaryMemory || searchMemory;
}

export function shouldUseRecentContext(question: string): boolean {
  const temporal = /(剛剛|剛才|剛才那段|剛剛那個|剛那個|剛[說講問提聊回發]|前面|上面|稍早|近期|最近|這陣子|這幾天|這週|本週|這個月|本月|之前|以前|上次|上回|前一次|前幾次|過去|歷史|昨天|前天|今天早上|今天下午|今天晚上|昨晚|previous|earlier|recent)/i.test(question);
  const context = /(對話|討論|聊天|聊什麼|講什麼|說什麼|內容|上下文|脈絡|前文|後續|這串|那串|訊息串|紀錄|聊天紀錄|context|conversation|discussion|chat)/i.test(question);
  const summary = /(摘要|總結|整理|重點|懶人包|summary|summarize)/i.test(question);
  return /(在討論什麼|討論什麼|聊什麼|聊了什麼|講什麼|說什麼|what did we talk about|what was discussed)/i.test(question) ||
    (temporal && context) ||
    (summary && (temporal || context));
}

export function shouldUseWebSearch(question: string): boolean {
  if (shouldUseRecentContext(question)) return false;
  if (/(記憶|歷史|對話|討論|聊天|訊息|上下文|聊天紀錄).*(搜尋|查詢|查一下|找一下|幫我找|找)|(?:搜尋|查詢|查一下|找一下|幫我找|找).*(記憶|歷史|對話|討論|聊天|訊息|上下文|聊天紀錄)/i.test(question)) {
    return false;
  }
  return /(上網|網路|網路搜尋|搜尋網路|查網路|google|最新|新聞|價格|股價|匯率|天氣|賽程|官方|rate limit|pricing|release|version|status|(?:今天|昨天|明天|今年|目前|現在).*(天氣|新聞|價格|股價|匯率|賽程|免費|活動|版本|模型|model|api|上限|限制|release|version|status)|(?:近期|最近).*(新聞|消息|價格|版本|模型|model|api|上限|限制))/i.test(question);
}

export function shouldClarifySearchScope(question: string): boolean {
  return /(找|找一下|幫我找|查|查一下|查詢|查查看|搜尋|search|find|look up)/i.test(question) &&
    !shouldSearchMemory(question) &&
    !shouldUseRecentContext(question) &&
    !shouldUseWebSearch(question);
}

export function shouldUseSpoilerWarning(text: string): boolean {
  return /(劇情|結局|暴雷|雷|防雷|有雷|爆雷|兇手|凶手|死|死亡|死掉|誰死|還活|活著|活下來|活下去|復活|存活|反轉|真相|黑幕|彩蛋|後續|最後|結尾|破關|全破|支線|主線|隱藏結局|好結局|壞結局|真結局|第[一二三四五六七八九十0-9]+[話集章季]|第[0-9]+集|最終[話章回])/.test(text);
}

function intentFromQuestion(question: string): IntentKind | null {
  if (shouldUseRecentContext(question)) return "recent_context";
  if (shouldSearchMemory(question)) return "memory";
  if (shouldUseWebSearch(question)) return "web_search";
  if (shouldClarifySearchScope(question)) return "ambiguous";
  return null;
}

function routeForIntent(intent: IntentKind, useSpoiler: boolean): IntentRoute {
  return {
    intent,
    useMemory: intent === "memory",
    useRecentContext: intent === "recent_context",
    useWebSearch: intent === "web_search",
    useSpoiler,
    clarifyingQuestion: intent === "ambiguous"
      ? "你是要查網路，還是查 Discord 聊天紀錄？"
      : null
  };
}

export function regexIntentRoute(question: string, ...messages: Array<PromptContent | undefined>): IntentRoute {
  return routeForIntent(
    intentFromQuestion(question) ?? "answer_only",
    shouldUseSpoilerWarning([question, ...messages.map((message) => message?.content ?? "")].join("\n"))
  );
}
