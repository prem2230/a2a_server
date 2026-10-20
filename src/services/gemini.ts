import { GoogleGenAI } from "@google/genai";

type GeminiClient = GoogleGenAI;
type ModelCall<T> = (client: GeminiClient, model: string) => Promise<T>;

function log(level: "info" | "warn" | "error", message: string, details?: Record<string, unknown>) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console[level](`[${new Date().toISOString()}] [GEMINI] ${message}${suffix}`);
}

function retryable(error: unknown): boolean {
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = Number(value?.status ?? value?.code);
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  const message = typeof value?.message === "string" ? value.message : String(error);
  return /\b(429|500|502|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

function attempts(): number {
  const configured = Number(process.env.GEMINI_RETRY_ATTEMPTS ?? 3);
  return Number.isInteger(configured) ? Math.min(5, Math.max(1, configured)) : 3;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function retryModel<T>(client: GeminiClient, model: string, call: ModelCall<T>, count: number, agent: string): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < count; attempt += 1) {
    const startedAt = Date.now();
    log("info", "request started", { agent, model, attempt: attempt + 1, maxAttempts: count });
    try {
      const result = await call(client, model);
      log("info", "request completed", { agent, model, attempt: attempt + 1, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      lastError = error;
      const retry = retryable(error) && attempt < count - 1;
      const errorMessage = error instanceof Error ? error.message.replace(/\s+/g, " ").slice(0, 180) : String(error).slice(0, 180);
      if (!retry) {
        log("error", "request failed", { agent, model, attempt: attempt + 1, durationMs: Date.now() - startedAt, retryable: retryable(error), error: errorMessage });
        throw error;
      }
      const backoff = Math.min(4000, 600 * 2 ** attempt) + Math.floor(Math.random() * 300);
      log("warn", "temporary model error; retrying", { agent, model, attempt: attempt + 1, durationMs: Date.now() - startedAt, retryInMs: backoff, error: errorMessage });
      await delay(backoff);
    }
  }
  throw lastError;
}

export async function withGeminiResilience<T>(agent: string, call: ModelCall<T>): Promise<T> {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("Agent workflow is unavailable: MODEL_API_KEY is not configured.");
  const client = new GoogleGenAI({ apiKey });
  const primary = process.env.MODEL_NAME ?? "gemini-3.1-flash-lite";
  const fallback = process.env.MODEL_FALLBACK_NAME ?? "gemini-3.8-flash";
  try {
    return await retryModel(client, primary, call, attempts(), agent);
  } catch (primaryError) {
    if (!retryable(primaryError) || fallback === primary) throw primaryError;
    log("warn", "switching to fallback model", { agent, from: primary, to: fallback });
    try {
      return await retryModel(client, fallback, call, 2, agent);
    } catch (fallbackError) {
      if (!retryable(fallbackError)) throw fallbackError;
      log("error", "primary and fallback models unavailable", { agent, primary, fallback });
      throw new Error(`Gemini is temporarily unavailable on both ${primary} and ${fallback}. Wait a minute and retry.`, { cause: fallbackError });
    }
  }
}
