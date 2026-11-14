# Clinic Appointment Booking

A small clinic appointment booking system: a Node.js/TypeScript API and a plain
HTML/CSS/TS frontend that consumes it. Built against the Koya Cohort 4
assessment spec: https://koyaacademy.com/assessment-api#/default/post_bookings

```
clinic-booking/
  backend/   Express + TypeScript API, Drizzle ORM, PostgreSQL
  frontend/  Vite + vanilla TypeScript single-page app
```

## Tech stack

- **Backend:** Node.js, TypeScript, Express 5
- **Database:** PostgreSQL (Neon or Supabase free tier), via [Drizzle ORM](https://orm.drizzle.team) and `pg`
- **Frontend:** Vite + vanilla TypeScript/HTML/CSS (no framework needed for this scope)
- **Tests:** Vitest + Supertest, run against [pg-mem](https://github.com/oguimbal/pg-mem) (see [Testing](#testing))

### Why this stack

Express's request handlers are plain `async` functions over a connection
pool, so handling concurrent requests correctly is a matter of pushing
mutual-exclusion down into the database rather than fighting a threading
model — see [Concurrency control](#concurrency-control-level-3) below. Drizzle
was chosen over raw `pg` for schema typing and query building, while staying
thin enough to drop into raw parameterized SQL (via `sql\`...\``) for the one
or two places that need it.

## API contract

The backend implements the exact contract in the technical spec linked above:
`POST /reset`, `GET /slots`, `POST /bookings`, `GET /bookings`,
`GET /bookings/{id}`, `DELETE /bookings/{id}`, all behind an `X-API-Key`
header, JSON only, errors shaped as `{"error": "<message>"}`.

### Design decisions worth knowing about

- **Double-booking guard (Level 3).** A booking and its `slot_locks` row (one
  row per slot with an active confirmed booking) are written in a single SQL
  statement using a CTE:
  ```sql
  WITH new_booking AS (INSERT INTO bookings (...) VALUES (...) RETURNING *),
       lock_slot   AS (INSERT INTO slot_locks (slot_id, booking_id)
                        SELECT slot_id, id FROM new_booking RETURNING *)
  SELECT * FROM new_booking;
  ```
  Every Postgres statement is implicitly its own transaction, so if two
  requests race for the same slot, the `slot_locks` primary key rejects the
  loser and the **whole statement** — including its `bookings` insert — rolls
  back atomically. The loser gets `409`. This is the "unique constraint on an
  active-booking table inside a transaction" approach named in the spec,
  expressed as one round trip instead of `BEGIN`/`INSERT`/`INSERT`/`COMMIT`.
  Cancellation uses the same pattern (conditional `UPDATE` + `DELETE` in one
  statement) so a double-cancel race can only ever free the slot once.
- **Idempotency (Level 4).** The `idempotency_keys` table stores the request
  body's hash alongside the response that was actually sent. A retried
  request with the same key and body replays that stored response verbatim
  (even if it was an error); the same key with a different body gets `422`.
- **Rate limiting (Level 5).** An in-memory sliding-window log, keyed by the
  email in the request body, 5 attempts/minute. In-memory is explicitly fine
  per the spec, and Render runs the API as one long-lived process (not a
  cold-starting serverless function), so the window persists correctly
  between requests.
- **Pagination (Level 4).** Keyset/cursor pagination ordered by
  `(created_at, id)`, with the cursor base64-encoding that pair — avoids the
  skipped/duplicated rows that offset pagination can produce under concurrent
  inserts.

## Local setup

### Backend

```bash
cd backend
npm install
cp .env.example .env   # fill in DATABASE_URL and API_KEY
npm run db:migrate     # applies drizzle/0000_init.sql
npm run db:seed        # populates upcoming slots for the next 7 weekdays
npm run dev            # http://localhost:3000
```

`.env`:

```
DATABASE_URL=postgresql://user:password@host:5432/dbname?sslmode=require
API_KEY=replace-with-a-long-random-string
PORT=3000
```

### Frontend

```bash
cd frontend
npm install
cp .env.example .env   # point at the backend above
npm run dev            # http://localhost:5173
```

`.env`:

```
VITE_API_BASE_URL=http://localhost:3000
VITE_API_KEY=same value as the backend's API_KEY
```

The frontend calls the API directly from the browser with this key attached,
which is a reasonable simplification for a take-home assessment; in a real
product you'd put a backend-for-frontend in front of it so the key never
reaches the client.

## Testing

```bash
cd backend
npm test
```

35 tests cover auth, Level 2 validation, Level 3 cancellation/conflict,
Level 4 idempotency/pagination, and Level 5 rate limiting — including firing
10 simultaneous `POST /bookings` requests at the same slot and asserting
exactly one succeeds (`tests/concurrency.test.ts`).

The suite runs against [pg-mem](https://github.com/oguimbal/pg-mem), a
pure-JavaScript Postgres-compatible engine, via Drizzle's `pg-proxy` driver —
**not** against the real `node-postgres` driver, which pg-mem's shim doesn't
fully implement. This means the tests need no Docker or local Postgres
install to run anywhere, while still exercising the real SQL (the CTEs,
unique constraints, `ON CONFLICT`) that runs against the real database in
production. See the comments in `backend/tests/setup.ts` for the specific
pg-mem quirks this works around.

## Deploying for free, over HTTPS

### 1. Database — Neon (or Supabase)

1. Create a free project at [neon.tech](https://neon.tech) (Supabase works
   the same way — grab its connection string instead).
2. Copy the pooled connection string it gives you — it already includes
   `?sslmode=require`.
3. From your machine, run the migration and seed script against it once:
   ```bash
   cd backend
   DATABASE_URL="<neon connection string>" npm run db:migrate
   DATABASE_URL="<neon connection string>" npm run db:seed
   ```

### 2. Backend — Render

1. Push this repo to GitHub.
2. On [render.com](https://render.com), **New → Web Service**, pick the repo.
3. Set:
   - **Root directory:** `backend`
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
4. Add environment variables:
   - `DATABASE_URL` — the Neon/Supabase connection string
   - `API_KEY` — a long random string (also used by the frontend)
   - `PORT` — Render sets this automatically; the app reads `process.env.PORT`
5. Deploy. Render gives you an HTTPS URL like
   `https://clinic-booking-api.onrender.com`. Migrations run automatically on
   boot (`src/index.ts` applies `drizzle/0000_init.sql` before listening), so
   no separate migration step is needed on Render itself.

### 3. Frontend — Vercel

1. On [vercel.com](https://vercel.com), **New Project**, pick the same repo.
2. Set:
   - **Root directory:** `frontend`
   - **Framework preset:** Vite
3. Add environment variables:
   - `VITE_API_BASE_URL` — your Render URL from step 2
   - `VITE_API_KEY` — the same `API_KEY` value
4. Deploy. Vercel gives you an HTTPS URL for the frontend; it calls the
   Render API directly (CORS is already enabled on the backend).

That's the whole chain: Vercel (frontend) → Render (API) → Neon/Supabase
(Postgres), all free-tier, all HTTPS.
