import "dotenv/config";
import express from "express";
import cors from "cors";
import * as helmetModule from "helmet";
import mongoose from "mongoose";
import { router, expireEscrows } from "./routes.js";

const app = express();
const port = Number(process.env.PORT ?? 4000);

app.use(helmetModule.default());
app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? "http://localhost:3000" }));
app.use(express.json({ limit: "1mb" }));
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "a2a-commerce-api" }));
app.use("/api", router);
app.use(
  (_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`[${new Date().toISOString()}] [API] Request failed`);
    res.status(500).json({ error: "The request could not be completed." });
  },
);

if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
await mongoose.connect(process.env.MONGODB_URI);
setInterval(() => {
  void expireEscrows().catch((error) => console.error("Escrow expiry job failed", error));
}, 30_000).unref();
app.listen(port, () => console.log(`A2A API listening on http://localhost:${port}`));
