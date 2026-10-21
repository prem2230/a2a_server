import { Router } from "express";
import bcrypt from "bcryptjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AuditEvent, Escrow, Listing, Negotiation, User, type Terms } from "./models.js";
import { makeToken, requireAuth } from "./auth.js";
import { runAgentTurn } from "./services/negotiation.js";
import { demoRouter } from "./demo.js";

export const router = Router();
router.use("/demo", demoRouter);
const registration = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().email().max(254),
  password: z.string().min(10).max(128),
});
const login = z.object({ email: z.string().email(), password: z.string().min(1) });
const listingInput = z.object({
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(10).max(3000),
  category: z.string().max(60).optional(),
  askingPrice: z.number().positive().max(1_000_000_000),
  currency: z.string().length(3).default("USD"),
  deliveryWindowHours: z.number().int().min(1).max(8760).default(168),
});
const safe = (data: unknown) => JSON.parse(JSON.stringify(data));
function escrowEncryptionKey(): Buffer {
  const key = Buffer.from(process.env.ESCROW_ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32)
    throw new Error("ESCROW_ENCRYPTION_KEY must be a base64 encoded 32-byte key");
  return key;
}
function encryptSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", escrowEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    secretCiphertext: ciphertext.toString("base64"),
    secretIv: iv.toString("base64"),
    secretTag: cipher.getAuthTag().toString("base64"),
  };
}
function decryptSecret(ciphertext: string, iv: string, tag: string) {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    escrowEncryptionKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

router.post("/auth/register", async (req, res) => {
  const parsed = registration.safeParse(req.body);
  if (!parsed.success)
    return res
      .status(400)
      .json({ error: parsed.error.issues[0]?.message ?? "Invalid account details" });
  try {
    const { password, ...profile } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      ...profile,
      email: profile.email.toLowerCase(),
      passwordHash,
    });
    return res.status(201).json({
      token: makeToken(String(user._id)),
      user: { id: String(user._id), name: user.name, email: user.email },
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000)
      return res.status(409).json({ error: "An account with this email already exists." });
    throw error;
  }
});
router.post("/auth/login", async (req, res) => {
  const parsed = login.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid email and password." });
  const user = await User.findOne({ email: parsed.data.email.toLowerCase() });
  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash)))
    return res.status(401).json({ error: "Email or password is incorrect." });
  return res.json({
    token: makeToken(String(user._id)),
    user: { id: String(user._id), name: user.name, email: user.email },
  });
});
router.get("/auth/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.userId).select("name email");
  if (!user) return res.status(404).json({ error: "Account not found" });
  return res.json({ id: String(user._id), name: user.name, email: user.email });
});

router.get("/listings", async (req, res) => {
  const listings = await Listing.find({
    status: "open",
    ...(req.query.q ? { $text: { $search: String(req.query.q) } } : {}),
  })
    .populate("sellerId", "name")
    .sort({ createdAt: -1 })
    .limit(100);
  return res.json(safe(listings));
});
router.post("/listings", requireAuth, async (req, res) => {
  const parsed = listingInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message });
  const listing = await Listing.create({ ...parsed.data, sellerId: req.userId });
  return res.status(201).json(listing);
});
router.get("/listings/mine", requireAuth, async (req, res) =>
  res.json(await Listing.find({ sellerId: req.userId }).sort({ createdAt: -1 })),
);

router.post("/negotiations", requireAuth, async (req, res) => {
  const id = z.string().safeParse(req.body?.listingId);
  if (!id.success) return res.status(400).json({ error: "listingId is required" });
  const listing = await Listing.findById(id.data);
  if (!listing || listing.status !== "open")
    return res.status(404).json({ error: "This listing is no longer available." });
  if (String(listing.sellerId) === req.userId)
    return res.status(400).json({ error: "You cannot negotiate with your own listing." });
  const existing = await Negotiation.findOne({
    listingId: listing._id,
    buyerId: req.userId,
    status: { $ne: "cancelled" },
  });
  if (existing) return res.json(existing);
  const negotiation = await Negotiation.create({
    listingId: listing._id,
    buyerId: req.userId,
    sellerId: listing.sellerId,
    messages: [
      {
        speaker: "system",
        text: `Negotiation opened for “${listing.title}”. The seller asks ${listing.currency} ${listing.askingPrice}.`,
      },
    ],
  });
  return res.status(201).json(negotiation);
});
router.get("/negotiations", requireAuth, async (req, res) =>
  res.json(
    await Negotiation.find({ $or: [{ buyerId: req.userId }, { sellerId: req.userId }] })
      .populate("listingId", "title askingPrice currency")
      .sort({ updatedAt: -1 }),
  ),
);
router.get("/negotiations/:id", requireAuth, async (req, res) => {
  const n = await Negotiation.findById(req.params.id).populate(
    "listingId",
    "title askingPrice currency description",
  );
  if (!n || ![String(n.buyerId), String(n.sellerId)].includes(req.userId!))
    return res.status(404).json({ error: "Negotiation not found" });
  return res.json(n);
});
router.post("/negotiations/:id/turn", requireAuth, async (req, res) => {
  const request = z.object({ message: z.string().trim().min(1).max(3000) }).safeParse(req.body);
  if (!request.success) return res.status(400).json({ error: "Add a message for your agent." });
  const n = await Negotiation.findById(req.params.id);
  if (!n || ![String(n.buyerId), String(n.sellerId)].includes(req.userId!))
    return res.status(404).json({ error: "Negotiation not found" });
  if (n.status !== "negotiating")
    return res.status(409).json({ error: "This negotiation is no longer open." });
  const side = String(n.buyerId) === req.userId ? "buyer" : "seller";
  const listing = await Listing.findById(n.listingId);
  if (!listing) return res.status(404).json({ error: "Listing not found" });
  const listingContext = {
    title: listing.title,
    description: listing.description,
    askingPrice: listing.askingPrice,
    currency: listing.currency,
  };
  const history = () =>
    n.messages.map((m: { speaker: string; text: string; proposedTerms?: unknown }) => ({
      speaker: m.speaker,
      text: m.text,
      proposedTerms: m.proposedTerms ? safe(m.proposedTerms) : undefined,
    }));
  const directed = await runAgentTurn({
    side,
    userMessage: request.data.message,
    principalDirection: true,
    listing: listingContext,
    messages: history(),
    terms: n.terms ? (safe(n.terms) as Terms) : undefined,
  });
  n.messages.push({
    speaker: side === "buyer" ? "buyer_agent" : "seller_agent",
    text: directed.text,
    ...(directed.terms ? { proposedTerms: directed.terms } : {}),
  });
  const counterpart = side === "buyer" ? "seller" : "buyer";
  const reply = await runAgentTurn({
    side: counterpart,
    userMessage: directed.text,
    principalDirection: false,
    listing: listingContext,
    messages: history(),
    terms: n.terms ? (safe(n.terms) as Terms) : undefined,
  });
  n.messages.push({
    speaker: counterpart === "buyer" ? "buyer_agent" : "seller_agent",
    text: reply.text,
    ...(reply.terms ? { proposedTerms: reply.terms } : {}),
  });
  const agreedTerms = reply.terms ?? directed.terms;
  if (agreedTerms) {
    n.terms = agreedTerms;
    n.termsVersion += 1;
    n.buyerAcceptedVersion = undefined;
    n.sellerAcceptedVersion = undefined;
  }
  await n.save();
  return res.json(n);
});
router.post("/negotiations/:id/accept", requireAuth, async (req, res) => {
  const n = await Negotiation.findById(req.params.id);
  if (!n || ![String(n.buyerId), String(n.sellerId)].includes(req.userId!))
    return res.status(404).json({ error: "Negotiation not found" });
  if (!n.terms || n.status !== "negotiating")
    return res.status(409).json({ error: "There are no open terms to accept." });
  if (String(n.buyerId) === req.userId) n.buyerAcceptedVersion = n.termsVersion;
  else n.sellerAcceptedVersion = n.termsVersion;
  if (n.buyerAcceptedVersion === n.termsVersion && n.sellerAcceptedVersion === n.termsVersion)
    n.status = "agreed";
  await n.save();
  return res.json(n);
});

router.post("/escrows", requireAuth, async (req, res) => {
  const id = z.string().safeParse(req.body?.negotiationId);
  if (!id.success) return res.status(400).json({ error: "negotiationId is required" });
  const n = await Negotiation.findById(id.data);
  if (!n || String(n.buyerId) !== req.userId)
    return res.status(404).json({ error: "Negotiation not found" });
  if (
    n.status !== "agreed" ||
    !n.terms ||
    n.buyerAcceptedVersion !== n.termsVersion ||
    n.sellerAcceptedVersion !== n.termsVersion
  )
    return res
      .status(409)
      .json({ error: "Both parties must accept the current terms before funding." });
  const exists = await Escrow.findOne({ negotiationId: n._id });
  if (exists)
    return res
      .status(409)
      .json({ error: "Escrow already exists for this negotiation.", escrowId: exists.id });
  const secret = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + n.terms.deliveryWindowHours * 60 * 60 * 1000);
  const commitment = {
    buyerId: String(n.buyerId),
    sellerId: String(n.sellerId),
    listingId: String(n.listingId),
    terms: safe(n.terms),
    expiresAt: expiresAt.toISOString(),
  };
  const secretHash = createHash("sha256")
    .update(`${secret}:${JSON.stringify(commitment)}`)
    .digest("hex");
  const escrow = await Escrow.create({
    negotiationId: n._id,
    listingId: n.listingId,
    buyerId: n.buyerId,
    sellerId: n.sellerId,
    termsSnapshot: safe(n.terms),
    amount: n.terms.amount,
    currency: n.terms.currency,
    ...encryptSecret(secret),
    secretHash,
    expiresAt,
  });
  await AuditEvent.create({
    escrowId: escrow._id,
    actorId: req.userId,
    action: "escrow_locked",
    detail: {
      amount: escrow.amount,
      currency: escrow.currency,
      hashCommitment: secretHash,
      expiresAt,
    },
  });
  const responseEscrow = escrow.toObject();
  delete responseEscrow.secret;
  delete responseEscrow.secretHash;
  delete responseEscrow.secretCiphertext;
  delete responseEscrow.secretIv;
  delete responseEscrow.secretTag;
  return res.status(201).json({ ...safe(responseEscrow), hashCommitment: secretHash, commitment });
});
router.get("/escrows", requireAuth, async (req, res) => {
  const rows = await Escrow.find({ $or: [{ buyerId: req.userId }, { sellerId: req.userId }] })
    .select("+secretHash")
    .sort({ createdAt: -1 });
  return res.json(
    rows.map((e) => {
      const row = e.toObject();
      delete row.secret;
      row.hashCommitment = row.secretHash;
      delete row.secretHash;
      return row;
    }),
  );
});
router.post("/escrows/:id/shipment", requireAuth, async (req, res) => {
  const parsed = z
    .object({
      reference: z.string().trim().min(2).max(250),
      evidence: z.string().trim().max(2000).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Provide a shipment reference." });
  const e = await Escrow.findById(req.params.id);
  if (!e || String(e.sellerId) !== req.userId)
    return res.status(404).json({ error: "Escrow not found" });
  if (e.status !== "locked" || e.expiresAt <= new Date())
    return res.status(409).json({ error: "This escrow is not accepting shipment updates." });
  e.status = "shipped";
  e.shipmentReference = parsed.data.reference;
  e.deliveryEvidence = parsed.data.evidence;
  await e.save();
  await AuditEvent.create({
    escrowId: e._id,
    actorId: req.userId,
    action: "shipment_submitted",
    detail: { reference: e.shipmentReference },
  });
  return res.json(e);
});
router.post("/escrows/:id/received", requireAuth, async (req, res) => {
  const e = await Escrow.findById(req.params.id);
  if (!e || String(e.buyerId) !== req.userId)
    return res.status(404).json({ error: "Escrow not found" });
  if (e.status !== "shipped")
    return res
      .status(409)
      .json({ error: "This delivery cannot be confirmed in its current state." });
  e.status = "released";
  e.releasedAt = new Date();
  await e.save();
  await AuditEvent.create({
    escrowId: e._id,
    actorId: req.userId,
    action: "funds_released",
    detail: { reason: "buyer_confirmed_delivery" },
  });
  return res.json(e);
});
router.get("/escrows/:id/settlement", requireAuth, async (req, res) => {
  const e = await Escrow.findById(req.params.id).select(
    "+secretCiphertext +secretIv +secretTag +secretHash",
  );
  if (!e || String(e.sellerId) !== req.userId)
    return res.status(404).json({ error: "Escrow not found" });
  if (e.status !== "released") return res.status(409).json({ error: "Settlement is not ready." });
  return res.json({
    secret: decryptSecret(e.get("secretCiphertext"), e.get("secretIv"), e.get("secretTag")),
    hash: e.get("secretHash"),
    commitment: {
      buyerId: String(e.buyerId),
      sellerId: String(e.sellerId),
      listingId: String(e.listingId),
      terms: e.termsSnapshot,
      expiresAt: e.expiresAt,
    },
  });
});
router.post("/escrows/:id/dispute", requireAuth, async (req, res) => {
  const e = await Escrow.findById(req.params.id);
  if (!e || ![String(e.buyerId), String(e.sellerId)].includes(req.userId!))
    return res.status(404).json({ error: "Escrow not found" });
  if (!["locked", "shipped"].includes(e.status))
    return res.status(409).json({ error: "This escrow cannot be disputed in its current state." });
  e.status = "disputed";
  await e.save();
  await AuditEvent.create({ escrowId: e._id, actorId: req.userId, action: "dispute_opened" });
  return res.json(e);
});
router.get("/escrows/:id/audit", requireAuth, async (req, res) => {
  const e = await Escrow.findById(req.params.id);
  if (!e || ![String(e.buyerId), String(e.sellerId)].includes(req.userId!))
    return res.status(404).json({ error: "Escrow not found" });
  return res.json(await AuditEvent.find({ escrowId: e._id }).sort({ createdAt: 1 }));
});
router.post("/admin/escrows/:id/resolve", async (req, res) => {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey || req.header("x-admin-key") !== adminKey)
    return res.status(401).json({ error: "Admin access required." });
  const parsed = z
    .object({
      resolution: z.enum(["release", "refund"]),
      reason: z.string().trim().min(5).max(1000),
    })
    .safeParse(req.body);
  if (!parsed.success)
    return res.status(400).json({ error: "Choose a resolution and provide a review reason." });
  const status = parsed.data.resolution === "release" ? "released" : "refunded";
  const escrow = await Escrow.findOneAndUpdate(
    { _id: req.params.id, status: "disputed" },
    {
      $set: {
        status,
        ...(status === "released" ? { releasedAt: new Date() } : { refundedAt: new Date() }),
      },
    },
    { new: true },
  );
  if (!escrow) return res.status(409).json({ error: "Escrow is not awaiting dispute review." });
  await AuditEvent.create({
    escrowId: escrow._id,
    action: `admin_${parsed.data.resolution}`,
    detail: { reason: parsed.data.reason },
  });
  return res.json(escrow);
});

export async function expireEscrows() {
  const expired = await Escrow.find({ status: "locked", expiresAt: { $lte: new Date() } }).limit(
    100,
  );
  for (const e of expired) {
    const updated = await Escrow.findOneAndUpdate(
      { _id: e._id, status: "locked", expiresAt: { $lte: new Date() } },
      { $set: { status: "refunded", refundedAt: new Date() } },
      { new: true },
    );
    if (updated)
      await AuditEvent.create({
        escrowId: updated._id,
        action: "funds_refunded",
        detail: { reason: "seller_shipment_window_expired" },
      });
  }
}
