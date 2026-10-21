export type AiMode = "demo" | "live";

let fallbackToDemo = false;

export function activateDemoFallback(reason: string): void {
  if (fallbackToDemo) return;
  fallbackToDemo = true;
  console.warn(`[${new Date().toISOString()}] [AI SERVICE] Live AI unavailable (${reason}); switching this server process to token-free demo mode.`);
}

export function isDemoMode(): boolean {
  if (process.env.IS_DEMO?.trim().toLowerCase() === "true") return true;
  if (fallbackToDemo) return true;
  if (!process.env.MODEL_API_KEY) {
    activateDemoFallback("AI service key is missing");
    return true;
  }
  return false;
}

export function currentAiMode(): AiMode {
  return isDemoMode() ? "demo" : "live";
}
