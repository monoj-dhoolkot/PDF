# Squeezely

A private-first image and PDF size reducer. The first working vertical slice is implemented: a responsive web UI, real image encoding/target-size search, loss-preserving PDF optimization with an optional Ghostscript image-downsampling pass, batch processing, verified output sizes, downloads/ZIPs, cancellation, retry, request throttling, and automatic temporary-file cleanup.

> **Operational status:** this repository is a working MVP, not yet a production multi-tenant service. Jobs and rate-limit counters currently live in process memory. Do not horizontally scale or deploy it for sensitive/high-volume workloads until the durable queue, PostgreSQL-backed identity/quotas, private object storage, and isolated worker milestones in [the architecture plan](docs/architecture.md) are completed.

## Start locally

Requirements: Node.js 22+, npm, and (for meaningful PDF image compression) Ghostscript. The app's PDF rewriter can still preserve/rewrite a PDF without Ghostscript, but it cannot reduce embedded scanned images. When Ghostscript is missing, the app now returns the best valid PDF, shows an explicit warning, and never reports a fake reduction. The downloaded PDF is still available.

Install Ghostscript before starting the API:

```sh
# Ubuntu / Debian
sudo apt-get update && sudo apt-get install -y ghostscript

# macOS with Homebrew
brew install ghostscript

# Verify
gs --version
```

On Windows install Ghostscript and set `GHOSTSCRIPT_PATH` in `.env` to the executable path, for example `C:\Program Files\gs\gs10.06.0\bin\gswin64c.exe`. Then restart the API. Alternatively, Docker Compose includes Ghostscript and avoids a host install.

```sh
cp .env.example .env
npm install
npm run dev
```

Open the Vite URL printed by the command (normally `http://localhost:5173`). The API runs on port 3000. The API stores originals and results in a private temporary directory and deletes finished job directories after 30 minutes. Set `DATA_DIR` to a private disk with enough free space. `MAX_FILE_BYTES`, `MAX_BATCH`, `MAX_QUEUED_JOBS`, `RETENTION_MINUTES`, and `WORKER_CONCURRENCY` are configurable.

Local Docker Compose (includes Ghostscript, a private persistent volume, and conservative container limits):

```sh
docker compose up --build
```

Or build/run manually:

```sh
docker build -t squeezely .
docker run --rm -p 3000:3000 -e DATA_DIR=/data -v squeezely-data:/data squeezely
```

Visit `http://localhost:3000`. The health endpoint is `/api/health`. Docker runs as an unprivileged user; mount a persistent, access-restricted volume at `/data`. The included `Dockerfile` is a single-instance deployment baseline, not an autoscaling topology.

## Verify

```sh
npm test
npm run typecheck
npm run build
```

PDF limits: Ghostscript must be installed for embedded-image downsampling. The PDF pipeline rewrites the PDF, tries increasingly compact Ghostscript image presets, validates every output with pdf-lib, and retains the largest candidate under a 2% safety margin where possible. It does not rasterize pages. Some encrypted, malformed, or unusually complex files will fail; no arbitrary target is guaranteed. Images use a binary quality search and reduce dimensions only when quality reduction alone does not meet the target. `1 KB = 1,024 bytes`; the UI displays the actual result and warns if the target was not met.

## External services and secrets

The current MVP has no external-service credentials or payment configuration. Ghostscript is a system package, not a secret. Production work requires PostgreSQL, Redis/BullMQ, private S3-compatible object storage, a session/auth provider or secure session implementation, a supported payment gateway, and monitoring/error tracking. Those credentials belong in the deployment secret manager (not `.env.example` or Git). The deployment guide and load-test report must be completed against the chosen provider before claiming production readiness.

See [docs/architecture.md](docs/architecture.md) for the proposed schema, folder map, trust boundaries, implementation milestones, and production readiness checklist. See [docs/deploy.md](docs/deploy.md) for a single-instance demo deployment and the requirements for a future scalable deployment.
