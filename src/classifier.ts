/**
 * Prompt classifier for the Smart Router.
 *
 * Pure functions only: no context mutation, no prompt logging. Extracts
 * features from the latest user message and the whole context (system prompt,
 * messages including tool calls/results, images), normalizes them to 0-1
 * signals, and computes a weighted complexity score.
 */

import type { Context, Message } from "@earendil-works/pi-ai";
import { DEFAULT_CLASSIFIER_CONFIG } from "./types.js";
import type { ClassifierConfig, PromptFeatures, RawPromptFeatures, RoutingRule } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Approximate characters per token for estimation. */
const CHARS_PER_TOKEN = 4;

/** Estimated token cost of one image block. */
const IMAGE_TOKEN_ESTIMATE = 512;

/** Number of tools a bare Pi coding session typically attaches by default. */
const TOOL_SIGNAL_BASELINE = 8;

const CODE_KEYWORDS = [
  "function", "class", "interface", "type", "const", "let", "var",
  "import", "export", "return", "async", "await", "promise",
  "component", "hook", "prop", "state", "render",
  "api", "endpoint", "route", "middleware", "handler",
  "database", "query", "migration", "schema",
  "test", "spec", "mock", "stub", "fixture",
  "stack trace", "traceback", "exception", "compile", "runtime error", "error", "crash",
  "refactor", "serialize", "parse", "regex",
];

const CODE_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/, // fenced code blocks
  /`[^`\n]+`/, // inline code
  /(?:^|\n)\s*(?:import|export|const|let|var|function|class|interface|type)\b/, // declaration lines
  /\b[a-z]+(?:_[a-z0-9]+)+\b/, // snake_case
  /\b[a-z]+[A-Z][a-zA-Z]*\b/, // camelCase
  /(?:^|\s)[\w./-]+\.[a-z]{2,4}\b/, // file paths / extensions
  /(?:^|\n)\s*at\s+[\w.$<>/]+\(?.*\)?/, // stack trace lines
  /[{}[\];]/, // code punctuation
];

const REASONING_KEYWORDS = [
  "prove", "derive", "formal reasoning", "compare tradeoffs", "trade-offs",
  "root cause", "architect", "design system", "algorithm",
  "complexity analysis", "step by step", "think through", "reason about",
  "analyze", "evaluate", "assess", "compare", "contrast",
  "implications", "consequences", "trade-off", "tradeoff", "pros and cons",
  "best practice", "anti-pattern", "design",
  // Review requests are evaluative work: reading a diff/commit and judging
  // correctness. Treated as reasoning so they don't fall into the fast tier.
  "review",
  // Opinion-seeking prompts: the user is asking for judgement, not facts.
  "do you think",
  "do you believe",
  "would you say",
  "would you consider",
];

const REASONING_PATTERNS: RegExp[] = [
  /\b(?:why|how|what)\s+(?:is|are|does|did|would|could|should)\b/i,
  /\b(?:explain|describe|analyze|compare|evaluate)\b/i,
  /\b(?:step\s+by\s+step|think\s+through|reason\s+about)\b/i,
  // Opinion-seeking: "do you think X", "would you say Y" — user wants
  // judgement, not a factual lookup. These deserve at least the balanced tier.
  /\b(?:do|would|could)\s+you\s+(?:think|believe|say|consider|recommend|prefer)\b/i,
  /\?$/, // question at end of prompt
];

/** Keyword groups used for the aggregate keywordSignal (and rule authoring). */
export const KEYWORD_GROUPS: Record<string, string[]> = {
  reasoning: REASONING_KEYWORDS,
  architecture: [
    "architect", "system design", "scalability", "microservice", "monolith",
    "database design", "schema", "migration",
  ],
  debugging: [
    "debug", "error", "exception", "crash", "fail", "bug",
    "stack trace", "traceback", "stderr", "stdout",
  ],
  performance: [
    "optimize", "performance", "slow", "latency", "throughput",
    "memory", "bottleneck", "profile", "benchmark",
  ],
  security: [
    "security", "vulnerability", "exploit", "injection", "xss",
    "csrf", "authorization", "encryption",
  ],
};

// ============================================================================
// Token estimation
// ============================================================================

/** Estimate token count from text (chars/4, rounded up). */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Concatenated text of a message's text blocks (empty for other roles). */
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  let out = "";
  for (const block of message.content) {
    if (block.type === "text") out += (out ? "\n" : "") + block.text;
  }
  return out;
}

/** Number of image blocks in a message. */
function messageImageCount(message: Message): number {
  if (typeof message.content === "string") return 0;
  let n = 0;
  for (const block of message.content) {
    if (block.type === "image") n++;
  }
  return n;
}

/** The latest user message in the context, if any. */
function latestUserMessage(context: Context) {
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i];
    if (msg.role === "user") return msg;
  }
  return undefined;
}

/** The latest user prompt as plain text (may be empty). */
export function getLatestUserPrompt(context: Context): string {
  const msg = latestUserMessage(context);
  return msg ? messageText(msg) : "";
}

/** Estimate whole-context tokens: system prompt, messages, tool calls/results, images. */
export function estimateContextTokens(context: Context): number {
  let total = estimateTokens(context.systemPrompt ?? "");

  for (const msg of context.messages) {
    total += estimateTokens(messageText(msg));
    total += messageImageCount(msg) * IMAGE_TOKEN_ESTIMATE;

    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          total += estimateTokens(JSON.stringify(block.arguments ?? {}));
        }
      }
    }
  }

  return total;
}

// ============================================================================
// Feature extraction
// ============================================================================

/** Build a word-boundary-wrapped regex for a keyword (boundaries only at word edges). */
function keywordRegex(escaped: string, flags: string): RegExp {
  const lead = /^\w/.test(escaped) ? "\\b" : "";
  const tail = /\w$/.test(escaped) ? "\\b" : "";
  return new RegExp(`${lead}${escaped}${tail}`, flags);
}

/** Count case-insensitive whole-phrase occurrences of a keyword in text. */
function countKeyword(text: string, keyword: string): number {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const matches = text.match(keywordRegex(escaped, "gi"));
  return matches ? matches.length : 0;
}

/** Count pattern matches with a fresh, non-stateful regex. */
function countPattern(text: string, pattern: RegExp): number {
  const matches = text.match(new RegExp(pattern.source, pattern.flags.replace("g", "") + "g"));
  return matches ? matches.length : 0;
}

/** Extract raw (un-normalized) features from the context. */
export function extractRawFeatures(context: Context, config: ClassifierConfig): RawPromptFeatures {
  const maxPromptTokens = config.maxPromptTokens ?? DEFAULT_CLASSIFIER_CONFIG.maxPromptTokens;
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_CLASSIFIER_CONFIG.maxContextTokens;

  let promptText = getLatestUserPrompt(context);
  // Truncate prompt text for analysis to keep classification bounded.
  const maxPromptChars = maxPromptTokens * CHARS_PER_TOKEN;
  if (promptText.length > maxPromptChars) promptText = promptText.slice(0, maxPromptChars);

  const promptTokens = estimateTokens(promptText);
  const contextTokens = Math.min(estimateContextTokens(context), maxContextTokens);

  const lowerPrompt = promptText.toLowerCase();

  // Code indicators: keyword hits count 1, structural pattern hits count 0.5.
  let codeIndicators = 0;
  for (const kw of CODE_KEYWORDS) codeIndicators += countKeyword(lowerPrompt, kw);
  for (const pattern of CODE_PATTERNS) codeIndicators += countPattern(promptText, pattern) * 0.5;

  // Reasoning indicators.
  let reasoningIndicators = 0;
  for (const kw of REASONING_KEYWORDS) reasoningIndicators += countKeyword(lowerPrompt, kw);
  for (const pattern of REASONING_PATTERNS) reasoningIndicators += countPattern(promptText, pattern);

  // Aggregate keyword-group signal: how many distinct group keywords appear.
  let keywordMatches = 0;
  for (const keywords of Object.values(KEYWORD_GROUPS)) {
    for (const kw of keywords) {
      if (countKeyword(lowerPrompt, kw) > 0) keywordMatches++;
    }
  }

  const toolCount = context.tools?.length ?? 0;

  let imageCount = 0;
  for (const msg of context.messages) imageCount += messageImageCount(msg);

  return {
    promptTokens,
    contextTokens,
    codeIndicators,
    reasoningIndicators,
    keywordMatches,
    toolCount,
    imageCount,
    hasTools: toolCount > 0,
    hasImages: imageCount > 0,
  };
}

/** Normalize raw features to 0-1 signals and compute the weighted complexity score. */
export function normalizeFeatures(raw: RawPromptFeatures, config: ClassifierConfig): PromptFeatures {
  const weights = { ...DEFAULT_CLASSIFIER_CONFIG.weights, ...config.weights };
  const maxPromptTokens = config.maxPromptTokens ?? DEFAULT_CLASSIFIER_CONFIG.maxPromptTokens;
  const maxContextTokens = config.maxContextTokens ?? DEFAULT_CLASSIFIER_CONFIG.maxContextTokens;

  // Token counts normalized on a log10 scale against their configured maxima.
  const promptTokensNorm = Math.min(1, Math.log10(raw.promptTokens + 1) / Math.log10(maxPromptTokens + 1));
  const contextTokensNorm = Math.min(1, Math.log10(raw.contextTokens + 1) / Math.log10(maxContextTokens + 1));

  const codeLikelihood = Math.tanh(raw.codeIndicators / 10);
  const reasoningLikelihood = Math.tanh(raw.reasoningIndicators / 5);
  const keywordSignal = Math.tanh(raw.keywordMatches / 5);
  // Tool availability is usually a session-level constant in Pi, not a prompt
  // difficulty signal. Only tools beyond a typical bare-session baseline add
  // complexity, so simply having the standard tool set does not consume the
  // cheap-tier score budget.
  const toolSignal = raw.hasTools
    ? Math.min(1, Math.max(0, raw.toolCount - TOOL_SIGNAL_BASELINE) / 10)
    : 0;
  const imageSignal = raw.hasImages ? Math.min(1, raw.imageCount / 5) : 0;

  const complexityScore = Math.min(
    1,
    Math.max(
      0,
      promptTokensNorm * (weights.promptTokens ?? 0) +
        contextTokensNorm * (weights.contextTokens ?? 0) +
        codeLikelihood * (weights.codeLikelihood ?? 0) +
        reasoningLikelihood * (weights.reasoningLikelihood ?? 0) +
        keywordSignal * (weights.keywordSignal ?? 0) +
        toolSignal * (weights.toolSignal ?? 0) +
        imageSignal * (weights.imageSignal ?? 0),
    ),
  );

  return {
    promptTokens: raw.promptTokens,
    contextTokens: raw.contextTokens,
    codeLikelihood,
    reasoningLikelihood,
    keywordSignal,
    toolSignal,
    imageSignal,
    hasTools: raw.hasTools,
    hasImages: raw.hasImages,
    complexityScore,
  };
}

/** Extract and normalize features in one call. */
export function classifyPrompt(context: Context, config: ClassifierConfig = {}): PromptFeatures {
  return normalizeFeatures(extractRawFeatures(context, config), config);
}

// ============================================================================
// Rule matching
// ============================================================================

/** Case-insensitive whole-phrase keyword test (keywords are regex-escaped). */
export function keywordMatches(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return keywordRegex(escaped, "i").test(text);
}

/** Threshold used for the boolean `code` / `reasoningRequired` rule conditions. */
const BOOLEAN_SIGNAL_THRESHOLD = 0.3;

/** Check whether a routing rule's match conditions hold. */
export function matchRule(
  rule: RoutingRule,
  features: PromptFeatures,
  promptText: string,
): boolean {
  const match = rule.match ?? {};

  if (match.anyKeywords?.length) {
    if (!match.anyKeywords.some((kw) => keywordMatches(promptText, kw))) return false;
  }

  if (match.allKeywords?.length) {
    if (!match.allKeywords.every((kw) => keywordMatches(promptText, kw))) return false;
  }

  if (match.minPromptTokens !== undefined && features.promptTokens < match.minPromptTokens) return false;
  if (match.minComplexity !== undefined && features.complexityScore < match.minComplexity) return false;

  if (match.code === true && features.codeLikelihood < BOOLEAN_SIGNAL_THRESHOLD) return false;
  if (match.code === false && features.codeLikelihood >= BOOLEAN_SIGNAL_THRESHOLD) return false;

  if (match.reasoningRequired === true && features.reasoningLikelihood < BOOLEAN_SIGNAL_THRESHOLD) return false;
  if (match.reasoningRequired === false && features.reasoningLikelihood >= BOOLEAN_SIGNAL_THRESHOLD) return false;

  if (match.hasTools === true && !features.hasTools) return false;
  if (match.hasTools === false && features.hasTools) return false;

  if (match.hasImages === true && !features.hasImages) return false;
  if (match.hasImages === false && features.hasImages) return false;

  return true;
}
