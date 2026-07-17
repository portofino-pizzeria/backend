# Portofino Pizzeria — Backend API

The ordering API for the Portofino mobile/web app (`../mobile`). Node +
TypeScript + **Fastify** + **Drizzle ORM** + **Postgres**. Money is always an
integer number of cents; currency is EUR.

Everything is **env-driven** so the *same* build runs locally, in staging, and in
production — only the environment differs (see `.env.example`).

## Endpoints

Customer (consumed by the mobile app — contract mirrors `../mobile/src/lib`):

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/menu` | Menu → `{ items }` |
| `POST` | `/api/orders` | Create order → `{ order }` |
| `GET`  | `/api/orders/:id` | Order (status polling) → `{ order }` |
| `GET`  | `/api/payments/providers` | `{ stripe, paypal, mockFallback }` |
| `POST` | `/api/payments/checkout` | Start hosted checkout → `{ url, provider }` |

Kitchen dashboard (ours — Bearer `KITCHEN_TOKEN` when set):

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/kitchen/orders?scope=active\|all` | List orders → `{ orders }` |
| `POST` | `/api/kitchen/orders/:id/status` | `{ status }` → `{ order }` |

Internal: `GET /api/health`, hosted checkout pages under `/checkout/*`, and
`POST /webhooks/stripe`.

## Order lifecycle

`pending_payment` → `paid` (payment) → `preparing` → `ready` (kitchen).
`cancelled` is reachable from any non-terminal state.

## Local development

Prereqs: **Node ≥ 20** and **Docker** (for local Postgres).

```bash
npm install
cp .env.example .env          # defaults work as-is for local/mock mode
npm run db:up                 # start Postgres (docker compose)
npm run db:generate           # generate the initial SQL migration from schema
npm run dev                   # migrates + seeds + serves on :4000
```

Then start the app in `../mobile` (`npm run web`) — it auto-targets
`http://localhost:4000`.

### Payments in dev

With no `STRIPE_SECRET_KEY`, checkout runs in **mock mode**: the app opens a
built-in confirmation page that marks the order paid — the full order → pay →
confirmation flow works with zero external setup. Add Stripe **test** keys to
`.env` to exercise real hosted Stripe Checkout (test cards, no real money).

## Deploy

Built for a container runtime (AWS App Runner) + managed Postgres (Aurora
Serverless v2), provisioned by the Terraform in `../infra`. `npm run build`
emits `dist/`; `npm start` runs it. Set the env vars from `.env.example` in the
service configuration.
