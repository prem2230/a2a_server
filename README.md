# API server

Express + TypeScript + MongoDB API. Copy `.env.example` to `.env`; never commit credentials. LLM is used only for buyer/seller dialogue and structured negotiation decisions. All escrow transitions are server-owned.

API groups: `/api/auth` (register, login, current account), `/api/listings` (browse, create, own listings), `/api/negotiations` (open, list, read, agent turns, accept terms), and `/api/escrows` (create simulated lock, shipment, receipt, dispute, audit, seller settlement proof). Dispute resolution is restricted to `POST /api/admin/escrows/:id/resolve` with the configured admin key.

The portfolio UI uses `POST /api/demo/run` as a Server-Sent Events stream. It creates temporary buyer/seller principals, persists their autonomous negotiation, and runs simulated institution and fulfillment agents through the escrow lifecycle. The endpoint is demo-only and rate-limited; it does not move funds or validate actual shipping evidence.

For local demo data, set `NODE_ENV=development` and run `npm run seed`. It creates `buyer@example.test` / `DemoBuyer!2026`, `seller@example.test` / `DemoSeller!2026`, and three open listings. These are demo credentials; change them before sharing a development environment. Seeded listings use the seller account, so sign in as the buyer to begin a negotiation.
