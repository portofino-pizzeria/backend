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

Kitchen dashboard (ours — Bearer `KITCHEN_TOKEN`, **required**; the guard fails
closed, see "The kitchen guard" below):

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

Prereqs: **Node ≥ 20.6** (`--env-file`) and **Docker** (for local Postgres).

```bash
npm install
cp .env.example .env          # defaults work as-is for local/mock mode …
                              # … except the kitchen dashboard: see below
npm run db:up                 # start Postgres (docker compose)
npm run db:generate           # generate the initial SQL migration from schema
npm run dev                   # loads .env, migrates + seeds + serves on :4000
```

`npm run dev`, `db:migrate` and `db:seed` all read `.env` and **refuse to start
without one** (`node: .env: not found`) — that is the `cp` above, not a broken
install. `npm start` never reads it; a deployed service is configured by its
platform.

Then start the app in `../mobile` (`npm run web`) — it auto-targets
`http://localhost:4000`.

### The kitchen guard

`/api/kitchen/*` returns every order's customer name, phone number and delivery
address, so its guard **fails closed**: with `KITCHEN_TOKEN` unset it refuses
every request rather than serving that data unauthenticated. There is no
"blank means open" — a deployment that forgets the token loses the kitchen
dashboard, never the customers' data.

For local dev, pick one in `.env`:

- `KITCHEN_AUTH_DISABLED=1` — no auth at all. The dashboard just works. Never
  set this anywhere but a laptop or CI; `/api/health` reports it as
  `kitchen: "auth-disabled"` and the deploy workflow fails a deploy that does.
- `KITCHEN_TOKEN=<anything>` — the real behaviour. The dashboard prompts for
  the token once and remembers it in the browser.

With neither, the dashboard's token prompt can never succeed (the server is
refusing, not checking), and the server says so at boot and in
`GET /api/health` → `kitchen: "unconfigured"`. The owner's menu editor
(`/api/admin/menu/*`, `OWNER_MENU_TOKEN`) fails closed the same way and has no
opt-out at all.

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
service configuration (`npm start` does not read `.env`; only the local
`dev` / `db:*` scripts do). `KITCHEN_TOKEN` and `OWNER_MENU_TOKEN` are the two
that are not optional there — both guards fail closed.

`.github/workflows/deploy.yml` ships it: on a push to `master` (or a
`workflow_dispatch` naming an older `sha`, which is how you roll back — a
workflow *re-run* replays the same commit and is not a rollback), it runs CI,
builds the image, pushes `:<sha>` then `:latest` to ECR, and then **proves the
push is live**.

That proof is the part worth reading. The service is already `RUNNING` before
the push and App Runner's auto-deploy is asynchronous, so polling for `RUNNING`
observes the *old* service and passes; an identical image digest fires no
deployment at all and that poll still passes. Instead the workflow snapshots
the service's deployment operations before the push, waits for one that was not
in that snapshot, waits for it to reach `SUCCEEDED`, and only then asserts that
`GET /api/health` reports the exact commit it built — and, once it does, that
its `kitchen` field reads `"token"`: the commit proves the code, this proves the
configuration it runs under. `"auth-disabled"` (the local-dev opt-out reached
production, so customer PII is on the open internet) and `"unconfigured"` (no
token reached the service, so the dashboard is dead) both fail the run; a build
too old to report the field is noted and not failed, so a rollback stays
possible.

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

The reviewer is read on every run, never assumed. When the workflow first
shipped there was none — required reviewers on a *private* repository in a
Free organisation answered `422 "Please ensure the billing plan supports the
required reviewers protection rule"` — and every deploy stopped at that first
step, which was the right outcome. One has since been added; if it is ever
removed, deploys stop again. To see the current state rather than trust this
paragraph:

```bash
gh api repos/portofino-pizzeria/backend/environments/production-backend \
  --jq '[.protection_rules[].type]'     # must contain "required_reviewers"
```

### Rolling back

Dispatch the workflow with `sha` set to a known-good commit (Actions → Deploy
backend → Run workflow). The commit must already be on `master`; the workflow
refuses anything else, because a dispatch must not be a route around review
for a change that applies migrations.

What happens next depends on whether ECR already holds an image for that
commit, which it does for anything this pipeline deployed before:

| `:<sha>` in ECR? | The workflow… |
|---|---|
| yes (a previous deploy) | **retags** it as `:latest` — no `docker build`, byte-for-byte the artifact that was known good (the workflow re-hashes the manifest against ECR's digest before pushing) |
| no (predates the pipeline), or `rebuild` ticked | builds it from source, pushes `:<sha>` then `:latest` |

Either way CI runs at that commit first — so a commit whose dependencies or
tests no longer pass is refused at the gate, retag or not — the deploy waits
at the same reviewer gate, and the same verification proves `/api/health`
reports that exact `commit` before the run goes green. The retag needs
`ecr:BatchGetImage` on the CI role, which `../infra/github-oidc.tf` grants
for precisely this.

Dispatching the sha `:latest` already names is a no-op: an unchanged tag
starts no App Runner deployment. If the service is not actually serving that
commit (a revision App Runner rolled back, say), the workflow says so
immediately; tick **`rebuild`** to push a fresh digest for the same commit.

**A rollback across a migration is not a rollback.** Migrations run on boot
and are not reversed by deploying older code; the old code would run against
the new schema. Treat that case as a forward fix.
