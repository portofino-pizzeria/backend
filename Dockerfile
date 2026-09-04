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

EXPOSE 4000
CMD ["node", "dist/index.js"]
