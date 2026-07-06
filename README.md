# RideNow v6

Rider + driver ride-hailing platform, runnable end-to-end on localhost.

**Stack:** TypeScript (strict) · NestJS API · Next.js rider & driver web apps · PostgreSQL 16 + PostGIS via Drizzle ORM · OpenStreetMap (Nominatim/OSRM) · Twilio OTP · Stripe test mode.

This repository is the founding scaffold: monorepo module layout, a health endpoint, CI, and a one-command local stack. Feature stories (phone-OTP signup, upfront fare quotes, live driver tracking, card payments, driver earnings ledger) build on top of it.

## Layout

```
apps/
  api/          NestJS backend — health endpoint + Drizzle DB layer   (:3000)
  rider-web/    Next.js rider app                                     (:3001)
  driver-web/   Next.js driver app                                    (:3002)
scripts/        seed / reset / demo helpers
docker-compose.yml
```

## Prerequisites

- Node.js 20 (see `.nvmrc`)
- Docker + Docker Compose

## Install

```bash
npm install
```

Installs from the committed `package-lock.json` on a fresh clone.

## Run the whole stack (one command)

```bash
docker compose up --build
```

- API health:  http://localhost:3000/health
- Rider web:   http://localhost:3001
- Driver web:  http://localhost:3002

The API health endpoint is the reachable URL for a 200 check (the PRD runs the product on localhost):

```bash
curl -fsS http://localhost:3000/health
# {"status":"ok","service":"ridenow-api","timestamp":"..."}
```

## Watch the core loop

```bash
bash ./scripts/demo.sh   # polls the API health endpoint until it returns 200
```

## Seed / reset the database

```bash
bash ./scripts/reset.sh  # drop the volume, recreate Postgres+PostGIS, seed demo data
```

## Quality checks (exactly what CI runs)

```bash
npm run lint
npm run typecheck
npm run test
```

## Environment

Copy `.env.example` to `.env` and fill in Twilio / Stripe **test** keys. In dev, OTPs are logged to the API console when Twilio is unset.

## CI

- `.github/workflows/ci.yml` — runs `lint`, `typecheck`, and `test` on every push/PR against a fresh clone (`npm install`, no cache).
- `.github/workflows/e2e.yml` — manually triggered; builds the core stack in Docker and asserts the health endpoint returns 200 (real proof the stack comes up).
