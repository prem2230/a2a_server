import mongoose, {
  Schema,
  type HydratedDocument,
  type InferSchemaType,
  type Model,
} from "mongoose";

function getModel<T>(name: string, schema: Schema<T>): Model<T> {
  return (mongoose.models[name] as Model<T> | undefined) ?? mongoose.model<T>(name, schema);
}

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true },
  },
  { timestamps: true },
);
const listingSchema = new Schema(
  {
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    category: { type: String, default: "Other" },
    askingPrice: { type: Number, required: true, min: 0.01 },
    currency: { type: String, default: "USD" },
    deliveryWindowHours: { type: Number, default: 168, min: 1 },
    status: { type: String, enum: ["open", "reserved", "closed"], default: "open", index: true },
  },
  { timestamps: true },
);
listingSchema.index({ title: "text", description: "text" });
const termsSchema = new Schema(
  {
    item: { type: String, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    currency: { type: String, required: true },
    deliveryWindowHours: { type: Number, required: true, min: 1 },
    deliveryMethod: { type: String, required: true },
    notes: { type: String, default: "" },
  },
  { _id: false },
);
const messageSchema = new Schema(
  {
    speaker: { type: String, enum: ["buyer_agent", "seller_agent", "system"], required: true },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    proposedTerms: { type: termsSchema },
  },
  { _id: true },
);
const negotiationSchema = new Schema(
  {
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: { type: String, enum: ["negotiating", "agreed", "cancelled"], default: "negotiating" },
    messages: { type: [messageSchema], default: [] },
    terms: { type: termsSchema },
    termsVersion: { type: Number, default: 0 },
    buyerAcceptedVersion: { type: Number },
    sellerAcceptedVersion: { type: Number },
  },
  { timestamps: true },
);
const escrowSchema = new Schema(
  {
    negotiationId: {
      type: Schema.Types.ObjectId,
      ref: "Negotiation",
      required: true,
      unique: true,
    },
    listingId: { type: Schema.Types.ObjectId, ref: "Listing", required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    sellerId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    termsSnapshot: { type: termsSchema, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    secretHash: { type: String, required: true, select: false },
    secretCiphertext: { type: String, required: true, select: false },
    secretIv: { type: String, required: true, select: false },
    secretTag: { type: String, required: true, select: false },
    status: {
      type: String,
      enum: ["locked", "shipped", "delivered", "released", "refunded", "disputed"],
      default: "locked",
      index: true,
    },
    expiresAt: { type: Date, required: true, index: true },
    shipmentReference: String,
    deliveryEvidence: String,
    releasedAt: Date,
    refundedAt: Date,
  },
  { timestamps: true },
);
const auditSchema = new Schema({
  escrowId: { type: Schema.Types.ObjectId, ref: "Escrow", required: true, index: true },
  actorId: { type: Schema.Types.ObjectId, ref: "User" },
  action: { type: String, required: true },
  detail: { type: Schema.Types.Mixed },
  createdAt: { type: Date, default: Date.now },
});

export type Terms = InferSchemaType<typeof termsSchema>;
export type ListingDocument = HydratedDocument<InferSchemaType<typeof listingSchema>>;
export type EscrowDocument = HydratedDocument<InferSchemaType<typeof escrowSchema>>;
export const User = getModel("User", userSchema);
export const Listing = getModel("Listing", listingSchema);
export const Negotiation = getModel("Negotiation", negotiationSchema);
export const Escrow = getModel("Escrow", escrowSchema);
export const AuditEvent = getModel("AuditEvent", auditSchema);
