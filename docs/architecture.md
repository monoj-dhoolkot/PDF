# Architecture proposal and delivery plan

## Repository inspection

The starting repository contained only a five-byte `README.md` and the initial Git commit. There was no framework, runtime, CI, database, design system, or existing product behavior to preserve. The implementation therefore begins with a small TypeScript/React client and a Node.js API that can be exercised locally without provisioning cloud services.

## Proposed production architecture

```text
Browser ── CDN/Next.js or static React ── stateless API
   │                                     ├── PostgreSQL (users, quotas, jobs, audit)
   ├── short-lived signed upload URL ───┤
   └── short-lived signed download URL ──┴── private S3-compatible object storage
                                             │
                                  Redis/BullMQ durable queues
                                             │
                         isolated image/PDF worker containers (Sharp/Ghostscript)
                                             │
                              metrics, structured logs, alerts, DLQ
```

The current implementation is a functional single-instance vertical slice: Vite/React UI, Express API, temporary private local disk, a bounded in-process job queue, Sharp/libvips image codecs, pdf-lib lossless rewrites, and Ghostscript for PDF image downsampling/recompression. CPU work runs asynchronously from the upload response, but still shares the API process. In-memory jobs are not durable or horizontally shareable. The UI is a client-rendered SPA, not server-rendered SEO pages. No authentication, billing, or admin service exists yet. These are explicit gaps, not simulated features.

## Folder map

```text
src/main.tsx              Accessible responsive UI, upload/settings/status/download flows
src/styles.css            Original responsive light/dark visual system
server/index.ts           Upload validation, in-process job lifecycle, API/rate limit/retention
server/compress.ts        Sharp target-size image search and PDF optimization/validation
 tests/compress.test.ts   Real generated image/PDF fixture tests
Dockerfile                Single-container production build with Ghostscript
.env.example              Safe local configuration defaults (no secrets)
docs/architecture.md      This architecture and delivery plan
```

## Proposed PostgreSQL schema

The target schema is normalized around tenant ownership and auditable job state. Use UUID primary keys, UTC timestamps, foreign keys, indexes on ownership/status/time, and never persist signed URLs or document contents.

- `users(id, email UNIQUE, password_hash/provider_subject, role, created_at, deleted_at)`
- `sessions(id, user_id FK, token_hash UNIQUE, expires_at, created_at)` — store only a hash of opaque session tokens.
- `plans(id, code UNIQUE, config JSONB, active)` — limits and benefits are editable/configurable, not hardcoded client entitlements.
- `subscriptions(id, user_id FK, plan_id FK, provider, provider_subscription_id UNIQUE, status, period_start, period_end, cancel_at_period_end, updated_at)`
- `jobs(id, owner_id FK NULL, anonymous_key_hash NULL, idempotency_key, kind, status, priority, target_bytes, options JSONB, input_bytes, output_bytes, queued_at, started_at, finished_at, expires_at, error_code)`
- `job_files(id, job_id FK, input_key, output_key, original_name, detected_mime, input_bytes, output_bytes, dimensions JSONB, page_count, compression_ratio, meets_target, state, error_code)` — object keys only; private bucket objects are lifecycle-expired.
- `usage_events(id, user_id FK NULL, anonymous_key_hash NULL, job_id FK, event_type, bytes, occurred_at)` — immutable quota/accounting events.
- `payment_events(provider_event_id UNIQUE, received_at, verified_at, payload_digest, processing_state)` — webhook idempotency; avoid retaining unnecessary payment payload PII.
- `admin_audit(id, actor_user_id FK, action, subject_id, redacted_details JSONB, created_at)`

Never trust plan IDs, quota values, file sizes, ownership, or payment state sent by the browser. Entitlements and every job/file lookup must be checked server-side. Anonymous quota identity should use a rotating HMAC of a stable signal, not raw IP persistence.

## Delivery milestones

1. **Working vertical slice (implemented):** drag/drop, batch file selection, real image compression, PDF rewrite/downsampling, target verification, downloadable output/ZIP, progress polling, cancellation between files, retry, input signatures, size/count/rate limits, health endpoint, temporary-file retention cleanup, responsive/dark UI, Docker baseline, tests.
2. **Durable processing (next):** PostgreSQL/Prisma migrations; Redis/BullMQ with idempotent jobs, backpressure, priority, exponential retry and dead-letter queue; separate resource-limited worker image; job cancellation signals; S3 multipart upload and signed URLs; lifecycle cleanup; per-user/IP limits in shared Redis. API must remain stateless before replicas are added.
3. **Accounts and commercial controls:** secure sessions/OIDC, registration/recovery/account deletion, server-enforced anonymous/free/pro/business quotas, verified payment webhooks and idempotency, subscription lifecycle/invoices, team membership and entitlements.
4. **Admin and operations:** server-enforced admin role, queue/job metrics and safe retry, quota/plan config, redacted audit trail, storage/cost reporting, structured logs, traces, alerting, backups and recovery drills.
5. **Discoverability and quality:** SSR/SSG landing/tool pages with unique helpful copy, metadata/canonical links, sitemap/robots, accessible component tests, security scanning, load and failure testing, measured production capacity report.

## Security and production checklist

- The current API uses random UUID job IDs, generates opaque storage paths, validates file content before processing, sanitizes output names, limits individual files to 30 MiB and batches to 80 MiB, caps batch size at 12, throttles requests per process/IP, runs Ghostscript with `-dSAFER` and subprocess timeout, and deletes terminal jobs after the configured retention window. These protections are useful but do not replace a sandbox.
- Run production workers as non-root, read-only where possible, no network access, with CPU/memory/PID/disk quotas and patched image/PDF tools. Enforce page-count, pixel-count, decompressed-size, processing-time and archive-size limits. Add antivirus/content disarm only where required by the threat model.
- Use TLS, CSRF controls for cookie-authenticated mutations, secure HttpOnly/SameSite cookies, strict CORS/CSP, shared rate limiting, short-lived signed object URLs, private buckets and access logs. Avoid logging original names where sensitive, file bodies, document text, credentials, or signed URLs.
- This MVP's job map and throttling map reset on restart and are not shared across replicas; its local disk is not object storage. Do not use it as a multi-replica or sensitive-document deployment. Docker health checks are included; alerting, backups, autoscaling and deletion verification are not yet implemented.

## Load-test plan (not yet run)

Do not infer a 1,000-user capacity from local development. Once the durable architecture exists, run staged tests with generated fixtures and record the exact worker/API/database/Redis/storage sizes and region:

1. 1,000 concurrent clients, mix of idle dashboard polls and upload initiation; measure p50/p95/p99 API latency and 429/error rate.
2. 1,000 simultaneous upload starts with 5–30 MiB images/PDFs; test storage throttling, signed URL expiry, multipart abort cleanup and network retries.
3. Burst of 5,000 jobs with mixed 1/10/30 MiB and 1/25/100-page PDFs; measure queue wait, service time, throughput, quality/target success, memory and CPU.
4. Kill workers during image/PDF jobs; verify visibility timeout/retry, idempotency, no duplicate billing, eventual DLQ and safe manual retry.
5. Load one abusive tenant and one malformed/large PDF while other tenants submit small jobs; verify fairness, admission control, memory isolation and cancellation.
6. Run retention/deletion checks against object storage and backup restore/recovery drills.

Publish measured throughput and latency with the report. Autoscaling thresholds should be based on queue age/depth, worker utilization and service objectives, not a fixed concurrency claim.
