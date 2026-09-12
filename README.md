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

## CI

`.github/workflows/ci.yml` — typecheck plus the full suite, on every pull
request and every push to `master`.

The suite is integration-shaped (pricing, availability and allergens are all
resolved in the database), so `vitest.config.ts`'s `globalSetup` refuses to run
without a live Postgres rather than skipping. CI therefore runs a
`services: postgres` container and points the suite at it with
`TEST_DATABASE_URL`. `drizzle/*.sql` is applied by `globalSetup` itself, from
zero, on every run — there is no separate migration step, deliberately.

## Deploy

Built for a container runtime (AWS App Runner) + managed Postgres (Aurora
Serverless v2), provisioned by the Terraform in `../infra`. `npm run build`
emits `dist/`; `npm start` runs it. Set the env vars from `.env.example` in the
service configuration.

`.github/workflows/deploy.yml` ships it: on a push to `master` it runs CI,
builds the image, pushes `:<sha>` then `:latest` to ECR, and then **proves the
push is live**. Only commits already on `master` can be deployed — a
`workflow_dispatch` naming anything else is refused, because migrations run on
container boot and a dispatch must not be a route around review.

That proof is the part worth reading. The service is already `RUNNING` before
the push and App Runner's auto-deploy is asynchronous, so polling for `RUNNING`
observes the *old* service and passes; an identical image digest fires no
deployment at all and that poll still passes. Instead the workflow snapshots
the service's deployment operations before the push, waits for one that was not
in that snapshot, waits for it to reach `SUCCEEDED`, and only then asserts that
`GET /api/health` reports the exact commit it built.

### Rolling back

A workflow *re-run* replays the same commit and is not a rollback. Roll back
with a `workflow_dispatch` (Actions → Deploy backend → Run workflow) naming a
known-good `sha`, in one of two modes:

| `retag` | What ships | When to use it |
|---|---|---|
| off (default) | a **rebuild** of that commit, through CI first | the ordinary case; the tree at that commit still builds |
| on | the image **already in ECR** at `:<sha>`, retagged to `:latest`, CI skipped | the tree at that commit no longer builds, or the dependency tree no longer resolves — which is exactly when a rollback is needed most |

Both modes go through the same environment gate and the same live-commit
verification. `retag` needs a `sha`, and it needs that commit to have been
deployed by this workflow before (only those carry a `:<sha>` tag); for anything
older, rebuild. The retag is two ECR calls (`batch-get-image` → `put-image`),
which is why the CI role holds `ecr:BatchGetImage` (`infra/github-oidc.tf`).

A rollback **across a migration is not a rollback** — the old code meets the
new schema. Treat that as a forward fix.

### The `commit` field

`GET /api/health` returns `commit` — the git sha the image was built from,
baked in at build time (`Dockerfile`: `ARG COMMIT_SHA` → `ENV COMMIT_SHA`), not
supplied at run time. A build without the arg reports `"unknown"`: honest, and
never a crash. It is also what makes each commit produce a distinct image
digest, which is what makes auto-deploy fire at all.

```bash
docker build --build-arg COMMIT_SHA="$(git rev-parse HEAD)" -t portofino-backend .
```

### Deploy configuration

Repository → Settings → Secrets and variables → Actions → **Variables**:

| Variable | Required | Default |
|---|---|---|
| `AWS_ROLE_ARN` | yes | — (`portofino-ci-backend`, assumed via GitHub OIDC) |
| `APPRUNNER_SERVICE_ARN` | yes | — |
| `AWS_REGION` | no | `eu-central-1` |
| `ECR_REPOSITORY` | no | `portofino-production-backend` |
| `PUBLIC_API_URL` | no | — (`https://api.<domain>`; when set, a verified deploy also checks the custom domain reports the same commit — **non-gating**, a warning only, since the App Runner domain is the service itself and a mismatch here is a DNS / domain-association problem, not a bad build) |

Optional secret `DEPLOY_ALERT_WEBHOOK` — a Slack/Teams incoming webhook that a
failed deploy POSTs to. Without it a failed deploy notifies nobody, which is
the same "invisible" defect as a stale site, just moved.

Nothing above is hardcoded in the workflow: both ARNs embed the AWS account id,
and a workflow copy of an infrastructure value is a silent drift channel.

### The human in the loop

Migrations run on **container boot** from `drizzle/` (`src/index.ts`), so a
backend deploy applies schema changes to production Aurora with no way back
once data is written under the new schema. The deploy job therefore runs
through the `production-backend` GitHub Environment with a **required
reviewer** — automatic to the door, human through it. Its first step verifies
that protection actually exists and fails closed if it does not, or if it
cannot tell.

The reviewer exists since 2026-09-11. It could not be configured while the
repository was **private**: required reviewers there need a GitHub Team or
Enterprise plan, `portofino-pizzeria` is on Free, and the API answered `422
"Please ensure the billing plan supports the required reviewers protection
rule"` — so the first three `master` pushes stopped at the gate, correctly. The
repository was made **public**, where the rule is available on Free, and
`production-backend` now carries it alongside its `master`-only branch policy.
Making the repository private again puts the rule back on a plan that does not
support it, and whether GitHub keeps listing an unenforced rule is not knowable
from the rules read — so the gate step also reads the repository's visibility
and refuses to deploy while it is private.

What public costs here: `ci.yml` runs for pull requests from forks, with a
read-only token and no secrets. The deploy workflow is `push` /
`workflow_dispatch` only, so it never runs for a fork, and the CI role's trust
policy is pinned to the `production-backend` environment subject, which only a
job that passed the gate can present.
