# --- build stage ------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# --- runtime stage ----------------------------------------------------------
FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
# App reads PORT (default 4000). App Runner sets/forwards this.
ENV PORT=4000

# Only what the server needs at runtime: prod deps, compiled JS, and the SQL
# migrations (applied on boot by src/index.ts).
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/data ./data
COPY package.json ./

# The git commit this image was built from, surfaced on GET /api/health so a
# deploy can prove the artifact it pushed is the one now serving traffic.
#
# Declared LAST on purpose. It changes on every commit, and every layer after
# an ARG/ENV is cache-invalidated by it — putting it here keeps `npm ci` and
# the TypeScript build cacheable while still changing the image config (and so
# the image digest) for each commit, which is what makes App Runner's
# auto-deploy fire at all.
#
# Defaulted, so `docker build .` with no --build-arg still produces a bootable
# image; the value it reports is then honestly "unknown".
ARG COMMIT_SHA=unknown
ENV COMMIT_SHA=${COMMIT_SHA}

EXPOSE 4000
CMD ["node", "dist/index.js"]
