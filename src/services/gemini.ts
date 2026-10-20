import { GoogleGenAI } from "@google/genai";

type GeminiClient = GoogleGenAI;
type ModelCall<T> = (client: GeminiClient, model: string) => Promise<T>;

function log(level: "info" | "warn" | "error", message: string, details?: Record<string, unknown>) {
  const suffix = details ? ` ${JSON.stringify(details)}` : "";
  console[level](`[${new Date().toISOString()}] [AI SERVICE] ${message}${suffix}`);
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
    log("info", "agent request started", { agent, attempt: attempt + 1, maxAttempts: count });
    try {
      const result = await call(client, model);
      log("info", "agent request completed", { agent, attempt: attempt + 1, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      lastError = error;
      const retry = retryable(error) && attempt < count - 1;
      if (!retry) {
        log("error", "agent request failed", { agent, attempt: attempt + 1, durationMs: Date.now() - startedAt, retryable: retryable(error) });
        throw new Error("AI service request failed. Check the AI service configuration and server logs.", { cause: error });
      }
      const backoff = Math.min(4000, 600 * 2 ** attempt) + Math.floor(Math.random() * 300);
      log("warn", "temporary AI service issue; retrying", { agent, attempt: attempt + 1, durationMs: Date.now() - startedAt, retryInMs: backoff });
      await delay(backoff);
    }
  }
  throw lastError;
}

export async function withGeminiResilience<T>(agent: string, call: ModelCall<T>): Promise<T> {
  const apiKey = process.env.MODEL_API_KEY;
  if (!apiKey) throw new Error("Agent workflow is unavailable: the AI service key is not configured.");
  const client = new GoogleGenAI({ apiKey });
  const primary = process.env.MODEL_NAME ?? "gemini-3.1-flash-lite";
  const fallback = process.env.MODEL_FALLBACK_NAME ?? "gemini-3.8-flash";
  try {
    return await retryModel(client, primary, call, attempts(), agent);
  } catch (primaryError) {
    if (!retryable(primaryError) || fallback === primary) throw primaryError;
    log("warn", "switching to backup AI service configuration", { agent });
    try {
      return await retryModel(client, fallback, call, 2, agent);
    } catch (fallbackError) {
      if (!retryable(fallbackError)) {
        log("error", "backup AI service request failed", { agent, retryable: false });
        throw new Error("AI service request failed. Check the AI service configuration and server logs.", { cause: fallbackError });
      }
      log("error", "AI service temporarily unavailable after retries", { agent, retryable: true });
      throw new Error("The AI service is temporarily unavailable. Wait a minute and try again.", { cause: fallbackError });
    }
  }
}
