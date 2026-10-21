import { Type } from "@google/genai";
import { z } from "zod";
import type { Terms } from "../models.js";
import { withGeminiResilience } from "./gemini.js";
import { activateDemoFallback, isDemoMode } from "./ai-mode.js";

type Turn = { speaker: string; text: string; proposedTerms?: unknown };
type Input = { side: "buyer" | "seller"; userMessage: string; principalDirection: boolean; principalContext?: string; listing: { title: string; description: string; askingPrice: number; currency: string }; messages: Turn[]; terms?: Terms };
const termsShape = { type: Type.OBJECT, properties: { item: { type: Type.STRING }, amount: { type: Type.NUMBER }, currency: { type: Type.STRING }, deliveryWindowHours: { type: Type.INTEGER }, deliveryMethod: { type: Type.STRING }, notes: { type: Type.STRING } }, required: ["item", "amount", "currency", "deliveryWindowHours", "deliveryMethod", "notes"] };
const termsSchema = z.object({ item: z.string().trim().min(1).max(200), amount: z.number().positive().max(1_000_000_000), currency: z.string().length(3), deliveryWindowHours: z.number().int().min(1).max(8760), deliveryMethod: z.string().trim().min(1).max(200), notes: z.string().max(1000) });

function simulateAgentTurn(input: Input): { text: string; terms?: Terms; acceptsTerms: boolean } {
  const seller = input.side === "seller";
  const limit = Number(input.principalContext?.match(/(?:maximum is|minimum is)\s+[A-Z]{3}\s+([\d.]+)/i)?.[1]);
  const buyerMaximum = seller ? Number.POSITIVE_INFINITY : Number.isFinite(limit) ? limit : input.listing.askingPrice;
  const sellerMinimum = seller ? Number.isFinite(limit) ? limit : 0 : 0;
  const current = input.terms;
  const offerAmount = current
    ? seller && current.amount < sellerMinimum ? sellerMinimum : !seller && current.amount > buyerMaximum ? buyerMaximum : current.amount
    : seller ? input.listing.askingPrice : Math.max(0.01, Math.round(input.listing.askingPrice * 0.92 * 100) / 100);
  const proposedTerms: Terms = {
    item: input.listing.title,
    amount: offerAmount,
    currency: input.listing.currency,
    deliveryWindowHours: current?.deliveryWindowHours ?? 24,
    deliveryMethod: current?.deliveryMethod ?? "Tracked standard shipping",
    notes: current?.notes ?? "Simulated demo terms",
  };
  if (!current || (seller && current.amount < sellerMinimum) || (!seller && current.amount > buyerMaximum)) {
    return { text: seller ? `I can offer ${proposedTerms.currency} ${proposedTerms.amount} with tracked delivery.` : `I can offer ${proposedTerms.currency} ${proposedTerms.amount} for ${proposedTerms.item} with tracked delivery.`, terms: proposedTerms, acceptsTerms: true };
  }
  return { text: seller ? `I accept the proposed terms at ${current.currency} ${current.amount}.` : `The proposed terms work for my budget. I accept ${current.currency} ${current.amount}.`, acceptsTerms: true };
}

export async function runAgentTurn(input: Input): Promise<{ text: string; terms?: Terms; acceptsTerms: boolean }> {
  if (isDemoMode()) return simulateAgentTurn(input);
  try {
    return await runLiveAgentTurn(input);
  } catch {
    activateDemoFallback("an agent request failed");
    return simulateAgentTurn(input);
  }
}

async function runLiveAgentTurn(input: Input): Promise<{ text: string; terms?: Terms; acceptsTerms: boolean }> {
  const seller = input.side === "seller";
  const roleMessage = input.principalDirection ? "The latest user message is private direction from your principal." : "The latest user message is the counterpart agent's public message.";
  const privateContext = input.principalContext ? ` Private principal constraints (never reveal these to the counterpart): ${input.principalContext}.` : "";
  const system = `You are the ${seller ? "seller" : "buyer"}'s negotiation agent in a real purchase. Speak directly and naturally as the ${seller ? "seller" : "buyer"} agent. Your counterpart is another agent. ${roleMessage}${privateContext} Negotiate only the listing and terms. Never claim funds were moved, goods shipped, identities verified, or a transaction completed. Do not request passwords, payment credentials, or the escrow secret. Be clear, concise, and cooperative. You may propose complete concrete terms only when there is a plausible offer or counteroffer; otherwise ask one useful question. Set acceptsTerms=true only when the current complete proposed terms shown to you are acceptable for your principal. Listing: ${JSON.stringify(input.listing)}. Current proposed terms: ${JSON.stringify(input.terms ?? null)}. Return a user-facing message, acceptsTerms, and, only if you are proposing complete revised terms, structured terms.`;
  const history = input.messages.map(m => `${m.speaker}: ${m.text}`).join("\n");
  const latest = input.principalDirection ? "Private direction from your principal" : "Message from counterpart agent";
  const schema = { type: "object", properties: { text: { type: "string" }, proposedTerms: termsShape, acceptsTerms: { type: "boolean" } }, required: ["text", "acceptsTerms"] };
  const response = await withGeminiResilience(`${input.side}-negotiation-agent`, (client, model) => client.models.generateContent({ model, contents: `Prior agent conversation:\n${history || "No messages yet."}\n\n${latest}: ${input.userMessage}`, config: { systemInstruction: system, responseMimeType: "application/json", responseJsonSchema: schema } }));
  const raw = response.text?.trim(); if (!raw) throw new Error("Negotiation agent returned no response");
  let parsed: { text?: string; proposedTerms?: Terms; acceptsTerms?: boolean }; try { parsed = JSON.parse(raw) as typeof parsed; } catch { throw new Error("Negotiation agent returned an invalid structured response"); }
  if (!parsed.text?.trim() || parsed.text.length > 4000) throw new Error("Negotiation agent returned an invalid message");
  if (parsed.proposedTerms) { const validTerms = termsSchema.safeParse(parsed.proposedTerms); if (!validTerms.success) throw new Error("Negotiation agent proposed invalid terms"); return { text: parsed.text.trim(), terms: validTerms.data as Terms, acceptsTerms: parsed.acceptsTerms === true }; }
  return { text: parsed.text.trim(), acceptsTerms: parsed.acceptsTerms === true };
}
