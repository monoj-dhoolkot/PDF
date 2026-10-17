# Deployment guide

## Recommended today: one Docker instance for a demo

For the current code, choose a host that can run the included Dockerfile and a single long-lived Node process. **Railway or Render are convenient for a demo**; deploy from this repository's Git branch, select Dockerfile/container deployment, expose the service's HTTP port, and set:

```text
NODE_ENV=production
DATA_DIR=/data
MAX_FILE_BYTES=31457280
MAX_BATCH=12
MAX_QUEUED_JOBS=100
RETENTION_MINUTES=30
WORKER_CONCURRENCY=2
```

The image installs Ghostscript. Configure a writable persistent disk/volume mounted at `/data` if the platform supports it; set the health check path to `/api/health`. Keep the service at one instance. The API respects the platform `PORT` environment variable (default 3000).

This is a **demo/staging deployment**, not a high-availability production configuration. Jobs are held in memory and files are local. A restart loses job state; on startup the app clears old local artifacts. Don't scale to multiple instances, accept sensitive documents, or claim 1,000-user capacity. Never rely on a host's ephemeral filesystem for documents users need to download later.

### Railway-style Docker deployment

1. Push this branch to the repository connected to your deployment host.
2. Create a new Docker-based web service from the repo; keep its replica count at one.
3. Add the variables above and attach a writable volume mounted at `/data` if available.
4. Enable public HTTP routing to the service port and set the health check to `GET /api/health`.
5. Deploy, open the service URL, and test an image and a PDF from a browser. Check the deployment logs for the API startup line and verify the download link.
6. For this MVP, redeploys invalidate active jobs/downloads. Don't change to multiple replicas as a workaround.

The platform's exact dashboard labels, volume policy, domain, and pricing can change; consult its current Docker deployment documentation. Render is a similar alternative for a single Docker Web Service. Avoid a frontend-only/serverless deployment such as Vercel for the current all-in-one process: CPU-heavy PDF work, local files, and in-memory jobs need a long-lived process and writable storage.

### Secrets and configuration

This version requires **no API keys or database credentials**. Do not add fake Stripe, Redis, database, or S3 secrets; those integrations are not implemented. Ghostscript is installed in the container and is not a secret. Store only actual future provider credentials in the host's secret manager. Never commit `.env`.

For local setup and system Ghostscript install commands, see the root README. To run the same container locally, use `docker compose up --build`.

## Production / scale deployment (not supported by this code yet)

For a real service and a 1,000-concurrent-user target, use a container platform such as AWS ECS/Fargate (or an equivalent managed container service), but first implement the next architecture milestones: stateless API, PostgreSQL, shared Redis/BullMQ, separate sandboxed worker containers, S3-compatible private storage with signed upload/download URLs, durable job state, and shared rate limiting. Only then run the load/failure tests in [architecture.md](architecture.md) and choose task counts and autoscaling thresholds from measured results. A bigger instance or CDN alone does not make the current in-memory queue horizontally scalable.
