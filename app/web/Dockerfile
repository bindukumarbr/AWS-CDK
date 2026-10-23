# syntax=docker/dockerfile:1

# ---- stage 1: install production dependencies only (reproducible: npm ci uses the lockfile) ----
FROM node:25-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---- stage 2: minimal runtime image ----
# ALT for a stricter posture: a distroless Node image (no shell, no package manager) shrinks the
# attack surface further. Alpine is used here because the container health check needs `node` only,
# and because the smaller CVE surface than a full Debian image is enough for this scope.
# In real use pin the base image by digest (FROM node:24-alpine@sha256:...) and let Dependabot bump it.
FROM node:25-alpine
ENV NODE_ENV=production
WORKDIR /app

# RDS CA bundle so the app can VERIFY the database certificate (not just encrypt the connection).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-ca.pem

COPY --from=deps /app/node_modules ./node_modules
COPY package.json server.js ./

USER node
EXPOSE 8080
CMD ["node", "server.js"]
