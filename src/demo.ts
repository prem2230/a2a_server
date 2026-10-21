import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AuditEvent, Escrow, Listing, Negotiation, User, type Terms } from "./models.js";
import { runAgentTurn } from "./services/negotiation.js";
import { withGeminiResilience } from "./services/gemini.js";
import { activateDemoFallback, currentAiMode, isDemoMode } from "./services/ai-mode.js";

export const demoRouter = Router();
const starts = new Map<string, number[]>();
const bodySchema = z
  .object({
    item: z.string().trim().min(3).max(120),
    buyerBudget: z.number().positive().max(100_000),
    sellerAsk: z.number().positive().max(100_000),
    sellerMinimum: z.number().positive().max(100_000),
    currency: z.string().length(3).default("USD"),
  })
  .refine((value) => value.sellerMinimum <= value.sellerAsk, {
    message: "Seller minimum must be at or below the asking price.",
  });

function send(res: Response, type: string, data: unknown) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
}
function encryptionKey(): Buffer {
  const key = Buffer.from(process.env.ESCROW_ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32)
    throw new Error("ESCROW_ENCRYPTION_KEY must be a base64 encoded 32-byte key");
  return key;
}
function encryptSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    secretCiphertext: ciphertext.toString("base64"),
    secretIv: iv.toString("base64"),
    secretTag: cipher.getAuthTag().toString("base64"),
  };
}
function simulateStructuredAgent<T>(agent: string, prompt: string): T {
  const input = JSON.parse(prompt) as Record<string, unknown>;
  let result: Record<string, unknown>;
  if (agent === "marketplace-discovery-agent") {
    const offers = Array.isArray(input.offers)
      ? (input.offers as Array<{ sellerIndex: number; askingPrice: number }>)
      : [];
    const eligible = offers
      .filter((offer) => offer.askingPrice <= Number(input.buyerMaximum))
      .sort((a, b) => a.askingPrice - b.askingPrice);
    result = eligible.length
      ? {
          sellerIndex: eligible[0]!.sellerIndex,
          reason: `Selected the lowest priced matching offer at ${eligible[0]!.askingPrice} within the buyer's budget.`,
        }
      : { sellerIndex: -1, reason: "No matching offer fits within the buyer's budget." };
  } else if (agent === "financial-institution-agent") {
    const expiry = new Date(String(input.expiresAt));
    const terms = input.terms as { amount?: number; currency?: string } | undefined;
    const valid =
      Number(input.amount) > 0 &&
      !!input.currency &&
      terms?.currency === input.currency &&
      terms?.amount === input.amount &&
      Number.isFinite(expiry.getTime()) &&
      expiry > new Date();
    result = {
      approved: valid,
      reason: valid
        ? "The transaction amount, currency, terms, and future expiry are consistent."
        : "The transaction record failed an amount, currency, terms, or expiry check.",
    };
  } else if (agent === "seller-fulfillment-agent") {
    const item = String(input.item ?? "demo item");
    const method = String(input.deliveryMethod ?? "simulated delivery");
    result = {
      reference: `DEMO-${randomBytes(4).toString("hex").toUpperCase()}`,
      description: `Simulated fulfillment for ${item} via ${method}. No real shipment occurred.`,
    };
  } else if (agent === "fulfillment-verifier-agent") {
    const shipment = input.shipment as { description?: string } | undefined;
    const description = shipment?.description ?? "";
    const valid =
      description.includes(String(input.agreedItem ?? "")) &&
      description.includes(String(input.deliveryMethod ?? "")) &&
      description.includes("Simulated fulfillment");
    result = {
      verified: valid,
      reason: valid
        ? "The simulated fulfillment record matches the agreed item and delivery method."
        : "The simulated fulfillment record does not match the agreed terms.",
    };
  } else {
    throw new Error(`No local demo behavior is defined for ${agent}.`);
  }
  return result as T;
}

async function askStructured<T>(
  agent: string,
  system: string,
  prompt: string,
  schema: Record<string, unknown>,
  onFallback?: () => void,
): Promise<T> {
  if (isDemoMode()) return simulateStructuredAgent<T>(agent, prompt);
  try {
    const response = await withGeminiResilience(agent, (client, model) =>
      client.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
        },
      }),
    );
    const raw = response.text?.trim();
    if (!raw) throw new Error("A workflow agent returned no response.");
    return JSON.parse(raw) as T;
  } catch {
    activateDemoFallback("a structured agent request failed");
    onFallback?.();
    return simulateStructuredAgent<T>(agent, prompt);
  }
}

demoRouter.post("/run", async (req: Request, res: Response) => {
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const recent = (starts.get(ip) ?? []).filter((timestamp) => now - timestamp < 10 * 60_000);
  if (recent.length >= 4)
    return res.status(429).json({ error: "Demo limit reached. Try again in a few minutes." });
  starts.set(ip, [...recent, now]);

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid demo setup" });
  let demoModeReported = isDemoMode();
  console.info(
    `[${new Date().toISOString()}] [A2A DEMO] starting ${currentAiMode() === "live" ? "live AI" : "token-free demo"} workflow`,
  );

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  const emit = (type: string, data: unknown) => {
    const event = data as { key?: string; label?: string; speaker?: string; status?: string };
    if (type === "stage")
      console.info(
        `[${new Date().toISOString()}] [A2A DEMO] ${event.key ?? "stage"}: ${event.label ?? "Workflow stage"}`,
      );
    else if (type === "message")
      console.info(
        `[${new Date().toISOString()}] [A2A DEMO] agent replied: ${event.speaker ?? "agent"}`,
      );
    else if (type === "done")
      console.info(
        `[${new Date().toISOString()}] [A2A DEMO] workflow finished: ${event.status ?? "unknown"}`,
      );
    else if (type === "error")
      console.error(`[${new Date().toISOString()}] [A2A DEMO] workflow paused after an error`);
    send(res, type, data);
  };
  const reportDemoFallback = () => {
    if (!demoModeReported && isDemoMode()) {
      demoModeReported = true;
      emit("mode", {
        mode: "demo",
        detail: "Live AI became unavailable; the workflow continued in token-free demo mode.",
      });
    }
  };
  if (demoModeReported)
    emit("mode", { mode: "demo", detail: "Server environment selected token-free demo mode." });
  else emit("mode", { mode: "live", detail: "Server environment selected live AI mode." });
  let activeEscrow: Awaited<ReturnType<typeof Escrow.create>> | null = null;

  try {
    const data = parsed.data;
    const runId = randomBytes(8).toString("hex");
    const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
    const buyer = await User.create({
      name: "Autonomous Buyer Agent",
      email: `demo-buyer-${runId}@example.test`,
      passwordHash,
    });
    const sellerCandidates: Array<{
      seller: typeof buyer;
      listing: Awaited<ReturnType<typeof Listing.create>>;
      reserve: number;
    }> = [];
    const priceFactors = [1, 0.94, 1.08];
    for (const [index, factor] of priceFactors.entries()) {
      const seller = await User.create({
        name: `Seller Agent ${index + 1}`,
        email: `demo-seller-${runId}-${index}@example.test`,
        passwordHash,
      });
      const ask = Math.max(1, Math.round(data.sellerAsk * factor * 100) / 100);
      const reserve = index === 0 ? data.sellerMinimum : Math.round(ask * 0.85 * 100) / 100;
      const listing = await Listing.create({
        sellerId: seller._id,
        title: data.item,
        description: "Demo inventory offered by a marketplace seller agent.",
        category: "Autonomous demo",
        askingPrice: ask,
        currency: data.currency,
        deliveryWindowHours: 24,
      });
      sellerCandidates.push({ seller, listing, reserve });
    }
    emit("stage", {
      key: "participants",
      label: "Buyer and seller agents created",
      detail: `A buyer agent and ${sellerCandidates.length} seller agents are now represented in MongoDB.`,
    });
    emit("stage", {
      key: "discovery",
      label: "Buyer agent searching seller inventory",
      detail: `Comparing ${sellerCandidates.length} matching offers for “${data.item}” against the buyer's private budget.`,
    });
    emit("agent_turn", { speaker: "buyer_agent", label: "Buyer agent is comparing seller offers" });
    const match = await askStructured<{ sellerIndex: number; reason: string }>(
      "marketplace-discovery-agent",
      "You are the buyer's marketplace discovery agent. Select the lowest priced matching offer that does not exceed the buyer's maximum budget. Return the zero-based sellerIndex from the supplied candidate list and a concise reason. If none fit, use -1.",
      JSON.stringify({
        item: data.item,
        buyerMaximum: data.buyerBudget,
        offers: sellerCandidates.map((candidate, index) => ({
          sellerIndex: index,
          title: candidate.listing.title,
          askingPrice: candidate.listing.askingPrice,
          currency: candidate.listing.currency,
        })),
      }),
      {
        type: "object",
        properties: { sellerIndex: { type: "integer" }, reason: { type: "string" } },
        required: ["sellerIndex", "reason"],
      },
      reportDemoFallback,
    );
    const affordable = sellerCandidates
      .map((candidate, index) => ({ candidate, index }))
      .filter((entry) => entry.candidate.listing.askingPrice <= data.buyerBudget)
      .sort((a, b) => a.candidate.listing.askingPrice - b.candidate.listing.askingPrice);
    if (affordable.length === 0) {
      emit("stage", {
        key: "no_match",
        label: "No seller offer fits the buyer's budget",
        detail: match.reason,
      });
      emit("done", { status: "no_match" });
      return res.end();
    }
    const modelChoice = sellerCandidates[match.sellerIndex];
    const selected =
      modelChoice &&
      modelChoice.listing.askingPrice <= data.buyerBudget &&
      modelChoice.listing.askingPrice === affordable[0]!.candidate.listing.askingPrice
        ? { candidate: modelChoice, index: match.sellerIndex }
        : affordable[0]!;
    const sellerChoice = selected.candidate;
    const { seller, listing, reserve: selectedSellerReserve } = sellerChoice;
    emit("stage", {
      key: "seller_selected",
      label: "Buyer agent selected the best matching seller",
      detail: `Offer ${selected.index + 1}: ${data.currency} ${listing.askingPrice}. ${match.reason}`,
    });
    const negotiation = await Negotiation.create({
      listingId: listing._id,
      buyerId: buyer._id,
      sellerId: seller._id,
      messages: [
        {
          speaker: "system",
          text: "Autonomous buyer and seller agents are active. Both agents will negotiate without human-authored chat turns.",
        },
      ],
    });

    let terms: Terms | undefined;
    let termsVersion = 0;
    let buyerAcceptedVersion = -1;
    let sellerAcceptedVersion = -1;
    let previousText = `Find the best deal for “${data.item}”. Your maximum budget is ${data.currency} ${data.buyerBudget}. Open with a reasonable offer and include a complete delivery proposal.`;
    let agreed = false;
    const listingContext = {
      title: listing.title,
      description: listing.description,
      askingPrice: listing.askingPrice,
      currency: listing.currency,
    };

    for (let turn = 0; turn < 4 && !agreed; turn += 1) {
      for (const side of ["buyer", "seller"] as const) {
        const principalDirection = turn === 0;
        const direction =
          side === "buyer"
            ? previousText
            : principalDirection
              ? `Private seller strategy: do not accept below ${data.currency} ${selectedSellerReserve}. Negotiate naturally with the buyer agent's latest public proposal.`
              : previousText;
        const principalContext =
          side === "buyer"
            ? `The buyer's absolute maximum is ${data.currency} ${data.buyerBudget}. Never agree above it.`
            : `The seller's confidential minimum is ${data.currency} ${selectedSellerReserve}. Never agree below it.`;
        emit("agent_turn", {
          speaker: side === "buyer" ? "buyer_agent" : "seller_agent",
          label: `${side === "buyer" ? "Buyer" : "Seller"} agent is preparing a reply`,
        });
        const result = await runAgentTurn({
          side,
          userMessage: direction,
          principalDirection,
          principalContext,
          listing: listingContext,
          messages: negotiation.messages.map((message) => ({
            speaker: message.speaker,
            text: message.text,
          })),
          ...(terms ? { terms } : {}),
        });
        reportDemoFallback();
        const speaker = side === "buyer" ? "buyer_agent" : "seller_agent";
        const validProposal =
          result.terms &&
          result.terms.amount <= data.buyerBudget &&
          result.terms.amount >= selectedSellerReserve
            ? result.terms
            : undefined;
        negotiation.messages.push({
          speaker,
          text: result.text,
          ...(validProposal ? { proposedTerms: validProposal } : {}),
        });
        emit("message", {
          speaker,
          text: result.text,
          ...(validProposal ? { terms: validProposal } : {}),
        });
        previousText = result.text;

        if (validProposal && JSON.stringify(validProposal) !== JSON.stringify(terms)) {
          terms = validProposal;
          termsVersion += 1;
          buyerAcceptedVersion = -1;
          sellerAcceptedVersion = -1;
          negotiation.terms = terms;
          negotiation.termsVersion = termsVersion;
        }
        if (terms && result.acceptsTerms) {
          if (side === "buyer") buyerAcceptedVersion = termsVersion;
          else sellerAcceptedVersion = termsVersion;
        }
        if (
          terms &&
          buyerAcceptedVersion === termsVersion &&
          sellerAcceptedVersion === termsVersion
        ) {
          agreed = true;
          break;
        }
      }
      await negotiation.save();
    }

    if (!agreed || !terms) {
      negotiation.status = "cancelled";
      await negotiation.save();
      emit("stage", {
        key: "no_agreement",
        label: "No agreement reached",
        detail:
          "The agents kept the transaction unfunded because they did not accept the same terms.",
      });
      emit("done", { status: "no_agreement", negotiationId: String(negotiation._id) });
      return res.end();
    }

    negotiation.status = "agreed";
    negotiation.buyerAcceptedVersion = termsVersion;
    negotiation.sellerAcceptedVersion = termsVersion;
    await negotiation.save();
    emit("stage", {
      key: "terms_agreed",
      label: "Both agents accepted the same terms",
      detail: `${terms.currency} ${terms.amount} · ${terms.deliveryMethod} · ${terms.deliveryWindowHours} hour deadline`,
    });

    const secret = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + terms.deliveryWindowHours * 60 * 60 * 1000);
    const commitment = {
      buyerId: String(buyer._id),
      sellerId: String(seller._id),
      listingId: String(listing._id),
      terms: JSON.parse(JSON.stringify(terms)),
      expiresAt: expiresAt.toISOString(),
    };
    const hash = createHash("sha256")
      .update(`${secret}:${JSON.stringify(commitment)}`)
      .digest("hex");
    const escrow = await Escrow.create({
      negotiationId: negotiation._id,
      listingId: listing._id,
      buyerId: buyer._id,
      sellerId: seller._id,
      termsSnapshot: terms,
      amount: terms.amount,
      currency: terms.currency,
      ...encryptSecret(secret),
      secretHash: hash,
      expiresAt,
    });
    activeEscrow = escrow;
    await AuditEvent.create({
      escrowId: escrow._id,
      actorId: buyer._id,
      action: "escrow_locked",
      detail: { amount: terms.amount, currency: terms.currency, hashCommitment: hash, expiresAt },
    });
    emit("stage", {
      key: "htlc_locked",
      label: "Escrow agent created the HTLC commitment",
      detail: `SHA-256 commitment binds buyer, seller, terms, and expiry: ${hash}`,
      amount: terms.amount,
      currency: terms.currency,
    });

    emit("stage", {
      key: "institution_review_started",
      label: "Financial institution agent is reviewing the escrow",
      detail: "Checking the deal amount, currency, terms, and expiration.",
    });
    const bankReview = await askStructured<{ approved: boolean; reason: string }>(
      "financial-institution-agent",
      "You are a simulated financial institution review agent. Review only the supplied transaction record for complete terms, positive amount, matching currency, and a future deadline. Do not claim real money moved. Approve only if every check passes.",
      JSON.stringify({
        amount: escrow.amount,
        currency: escrow.currency,
        terms,
        expiresAt,
        hashCommitment: hash,
      }),
      {
        type: "object",
        properties: { approved: { type: "boolean" }, reason: { type: "string" } },
        required: ["approved", "reason"],
      },
      reportDemoFallback,
    );
    const institutionApproved = bankReview.approved === true;
    emit("stage", {
      key: institutionApproved ? "institution_approved" : "institution_rejected",
      label: institutionApproved
        ? "Financial institution agent approved the lock"
        : "Financial institution agent rejected the lock",
      detail: bankReview.reason,
    });
    await AuditEvent.create({
      escrowId: escrow._id,
      action: institutionApproved ? "institution_approved" : "institution_rejected",
      detail: { reason: bankReview.reason },
    });
    if (!institutionApproved) {
      escrow.status = "disputed";
      await escrow.save();
      emit("done", {
        status: "review_required",
        negotiationId: String(negotiation._id),
        escrowId: String(escrow._id),
      });
      return res.end();
    }

    emit("agent_turn", {
      speaker: "seller_agent",
      label: "Seller agent is preparing simulated delivery evidence",
    });
    const shipment = await askStructured<{ reference: string; description: string }>(
      "seller-fulfillment-agent",
      "You are a simulated seller fulfillment agent. Generate a clearly fictional shipment reference and a concise fulfillment description for the agreed goods. Do not claim a real carrier or real delivery.",
      JSON.stringify({
        item: terms.item,
        deliveryMethod: terms.deliveryMethod,
        amount: terms.amount,
      }),
      {
        type: "object",
        properties: { reference: { type: "string" }, description: { type: "string" } },
        required: ["reference", "description"],
      },
      reportDemoFallback,
    );
    escrow.status = "shipped";
    escrow.shipmentReference = shipment.reference.slice(0, 250);
    escrow.deliveryEvidence = shipment.description.slice(0, 2000);
    await escrow.save();
    await AuditEvent.create({
      escrowId: escrow._id,
      actorId: seller._id,
      action: "shipment_submitted",
      detail: { reference: escrow.shipmentReference, simulated: true },
    });
    emit("stage", {
      key: "shipment_submitted",
      label: "Seller agent submitted simulated shipment",
      detail: `${shipment.reference} · ${shipment.description}`,
    });

    const verification = await askStructured<{ verified: boolean; reason: string }>(
      "fulfillment-verifier-agent",
      "You are an independent simulated fulfillment verifier. Compare the agreed item and delivery method with the submitted shipment description. Verify only that the evidence is internally consistent; it is not real-world proof. Be conservative.",
      JSON.stringify({ agreedItem: terms.item, deliveryMethod: terms.deliveryMethod, shipment }),
      {
        type: "object",
        properties: { verified: { type: "boolean" }, reason: { type: "string" } },
        required: ["verified", "reason"],
      },
      reportDemoFallback,
    );
    const fulfillmentVerified = verification.verified === true;
    emit("stage", {
      key: fulfillmentVerified ? "fulfillment_verified" : "fulfillment_rejected",
      label: fulfillmentVerified
        ? "Fulfillment verification agent approved the evidence"
        : "Fulfillment verification agent flagged the evidence",
      detail: verification.reason,
    });
    await AuditEvent.create({
      escrowId: escrow._id,
      action: fulfillmentVerified ? "fulfillment_verified" : "fulfillment_rejected",
      detail: { reason: verification.reason, simulated: true },
    });
    if (!fulfillmentVerified) {
      escrow.status = "disputed";
      await escrow.save();
      emit("done", {
        status: "review_required",
        negotiationId: String(negotiation._id),
        escrowId: String(escrow._id),
      });
      return res.end();
    }

    escrow.status = "delivered";
    await escrow.save();
    emit("stage", {
      key: "delivery_confirmed",
      label: "Buyer agent confirmed the verified delivery",
      detail: "The fulfillment evidence matched the agreed item and delivery terms.",
    });
    escrow.status = "released";
    escrow.releasedAt = new Date();
    await escrow.save();
    await AuditEvent.create({
      escrowId: escrow._id,
      actorId: buyer._id,
      action: "funds_released",
      detail: { reason: "autonomous_demo_fulfillment_verified", simulated: true },
    });
    emit("stage", {
      key: "settled",
      label: "Escrow agent released the simulated funds",
      detail: "The secret preimage is now released to the seller agent. No real funds moved.",
    });
    emit("secret_release", { secret, hash });
    emit("done", {
      status: "released",
      negotiationId: String(negotiation._id),
      escrowId: String(escrow._id),
      hashCommitment: hash,
    });
    return res.end();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] [A2A DEMO] autonomous workflow failed`);
    if (
      activeEscrow &&
      (activeEscrow.status === "locked" ||
        activeEscrow.status === "shipped" ||
        activeEscrow.status === "delivered")
    ) {
      activeEscrow.status = "disputed";
      await activeEscrow.save();
      await AuditEvent.create({
        escrowId: activeEscrow._id,
        action: "demo_workflow_interrupted",
        detail: { reason: "agent_or_service_error", simulated: true },
      });
      emit("stage", {
        key: "review_required",
        label: "Workflow paused for review",
        detail: "An agent or service stopped responding. Escrow remains frozen.",
      });
    }
    emit("error", {
      error: error instanceof Error ? error.message : "Autonomous workflow failed.",
    });
    return res.end();
  }
});
