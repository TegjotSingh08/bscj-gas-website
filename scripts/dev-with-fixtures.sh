#!/usr/bin/env bash
#
# The development server with every external service stubbed in-process.
#
# Development only. It exports fixture credentials *before* Next starts, which
# is what makes them win over `.env.local` — Next never overwrites a variable
# the environment already holds — and preloads the interceptor in
# `scripts/browser-fixtures.mjs`, so a request to Google, Upstash or Resend is
# answered locally whatever the credentials happen to say.
#
# The database is the real local development database. It is deliberately not
# stubbed: a hand-written stand-in for an ORM proves things about the stand-in.
set -euo pipefail

export GOOGLE_SERVICE_ACCOUNT_EMAIL="fixture@example.invalid"
# A throwaway key, generated fresh on every run and never written to disk.
# The Google client signs its own JWT *before* it reaches the network, so the
# interceptor cannot stand in for this step: the key has to be a real one.
# Nothing verifies the signature — the fake token endpoint answers regardless.
export GOOGLE_PRIVATE_KEY="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null)"
export GOOGLE_CALENDAR_ID="fixture-calendar"
export UPSTASH_REDIS_REST_URL="https://fixture-redis.invalid"
export UPSTASH_REDIS_REST_TOKEN="fixture-token"
# A throwaway key, so the send path actually *runs* and the interceptor
# answers it. `api.resend.com` is replaced by the stub above for the whole
# process, so this value cannot reach Resend — and with an empty key the code
# short-circuits as "not configured" and no message is ever built, which makes
# the email path impossible to verify at all.
export RESEND_API_KEY="${RESEND_API_KEY:-fixture-resend-key}"
export BOOKING_EMAIL_FROM="${BOOKING_EMAIL_FROM:-fixtures@example.invalid}"
export AUTH_SECRET="fixture-auth-secret-for-local-browser-tests"
export SCHEDULING_TOKEN_SECRET="fixture-scheduling-secret"
export BSCJ_FIXTURE_STATE="${BSCJ_FIXTURE_STATE:-/tmp/bscj-fixture-state.json}"
# A document store on this machine, so certificates and invoices can actually
# be written and read back. The local driver refuses to load in production, so
# this cannot follow the code anywhere it should not be.
export BSCJ_DOCUMENT_STORE="${BSCJ_DOCUMENT_STORE:-local}"
export BSCJ_DOCUMENT_DIR="${BSCJ_DOCUMENT_DIR:-/tmp/bscj-documents}"
# The interceptor refuses to install without this, so a stray NODE_OPTIONS
# cannot stub anybody's network by accident.
export BSCJ_TEST_FIXTURES=1
export NODE_OPTIONS="--import ./scripts/browser-fixtures.mjs ${NODE_OPTIONS:-}"

exec npx next dev --port "${PORT:-3100}"
