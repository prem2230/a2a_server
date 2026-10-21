import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { Listing, User } from "./models.js";

if (process.env.NODE_ENV === "production") {
  throw new Error("Refusing to seed demo data while NODE_ENV=production.");
}
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

const demoAccounts = [
  { name: "Avery Buyer (Demo)", email: "buyer@example.test", password: "DemoBuyer!2026" },
  { name: "Sam Seller (Demo)", email: "seller@example.test", password: "DemoSeller!2026" },
];

await mongoose.connect(process.env.MONGODB_URI);
try {
  const users = new Map<string, string>();
  for (const account of demoAccounts) {
    const passwordHash = await bcrypt.hash(account.password, 12);
    const user = await User.findOneAndUpdate(
      { email: account.email },
      { $set: { name: account.name, passwordHash, email: account.email } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    users.set(account.email, String(user._id));
  }

  const sellerId = users.get("seller@example.test");
  if (!sellerId) throw new Error("Demo seller account was not created");
  const listings = [
    {
      title: "Handmade ceramic pour-over set",
      description:
        "A handmade stoneware dripper and matching server. Excellent condition, packed carefully for shipping.",
      category: "Home goods",
      askingPrice: 68,
      currency: "USD",
      deliveryWindowHours: 168,
    },
    {
      title: "Refurbished mechanical keyboard",
      description:
        "A clean 75 percent mechanical keyboard with tactile switches and USB-C cable. Seller will ship with tracking.",
      category: "Electronics",
      askingPrice: 115,
      currency: "USD",
      deliveryWindowHours: 120,
    },
    {
      title: "Vintage landscape print",
      description:
        "Framed landscape print, 40 by 50 centimetres. Minor frame wear; local courier or pickup can be discussed.",
      category: "Art",
      askingPrice: 90,
      currency: "USD",
      deliveryWindowHours: 72,
    },
  ];

  for (const item of listings) {
    await Listing.findOneAndUpdate(
      { sellerId, title: item.title },
      { $set: { ...item, sellerId, status: "open" } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  console.log("Demo data is ready.");
  console.log("Buyer: buyer@example.test / DemoBuyer!2026");
  console.log("Seller: seller@example.test / DemoSeller!2026");
  console.log("Listings: 3 open demo items");
} finally {
  await mongoose.disconnect();
}
