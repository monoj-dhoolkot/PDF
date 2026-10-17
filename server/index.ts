import express from 'express';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import archiver from 'archiver';
import sharp from 'sharp';
import { compressImage, compressPdf, formatBytes, type OutputFormat, type CompressionResult } from './compress.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES || 30 * 1024 * 1024);
const MAX_BATCH = Number(process.env.MAX_BATCH || 12);
const MAX_QUEUED_JOBS = Number(process.env.MAX_QUEUED_JOBS || 100);
const RETENTION_MS = Number(process.env.RETENTION_MINUTES || 30) * 60_000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(os.tmpdir(), 'squeezely-data'));
await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
// This local single-instance store has no durable job catalog. Purge abandoned artifacts from a prior restart.
await Promise.all((await fs.readdir(DATA_DIR)).map(entry => fs.rm(path.join(DATA_DIR, entry), { recursive: true, force: true })));
await fs.mkdir(path.join(DATA_DIR, 'incoming'), { recursive: true, mode: 0o700 });
app.disable('x-powered-by');
app.use((_, res, next) => { res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY'); next(); });

const buckets = new Map<string, { started: number; count: number }>();
app.use('/api', (req, res, next) => {
  const key = req.ip || 'unknown'; const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.started > 60_000) { bucket = { started: now, count: 0 }; buckets.set(key, bucket); }
  bucket.count += 1;
  if (bucket.count > 90) return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  next();
});

interface Item { name: string; inputPath: string; outputPath: string; status: 'queued' | 'processing' | 'done' | 'error' | 'cancelled'; result?: CompressionResult; error?: string }
interface Job { id: string; createdAt: number; expiresAt: number; type: 'image' | 'pdf'; status: 'queued' | 'processing' | 'done' | 'error' | 'cancelled'; progress: number; cancelled: boolean; items: Item[]; options: { targetBytes: number; format: OutputFormat; quality: number; width?: number; height?: number; preset: 'balanced' | 'quality' | 'maximum'; grayscale: boolean } }
const jobs = new Map<string, Job>();
const pending: Job[] = [];
let running = 0;
const CONCURRENCY = Math.max(1, Math.min(4, Number(process.env.WORKER_CONCURRENCY || 2)));
const upload = multer({
  dest: path.join(DATA_DIR, 'incoming'),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_BATCH, fields: 12 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.avif', '.heic', '.heif', '.pdf'].includes(ext)) return cb(null, true);
    cb(new Error('Unsupported file extension. Upload JPG, PNG, WebP, AVIF, HEIC, or PDF files.'));
  },
});

function safeName(name: string): string {
  const base = path.basename(name).normalize('NFKC').replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^[. -]+|[. -]+$/g, '').slice(0, 100);
  return base || 'compressed-file';
}
function numeric(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
}
function serialize(job: Job) {
  return { id: job.id, type: job.type, status: job.status, progress: job.progress, expiresAt: new Date(job.expiresAt).toISOString(), files: job.items.map((item, index) => ({ index, name: item.name, status: item.status, error: item.error, result: item.result ? { bytes: item.result.bytes, originalBytes: item.result.originalBytes, width: item.result.width, height: item.result.height, format: item.result.format, reduction: item.result.reduction, meetsTarget: item.result.meetsTarget, warning: item.result.warning, pages: item.result.pages, downloadUrl: `/api/jobs/${job.id}/files/${index}` } : undefined })) };
}
function isPdf(buffer: Buffer) { return buffer.subarray(0, 5).toString() === '%PDF-'; }
function imageExtension(format: string) { return format === 'jpeg' ? 'jpg' : format; }

async function processItem(job: Job, item: Item) {
  if (job.cancelled) { item.status = 'cancelled'; return; }
  item.status = 'processing';
  try {
    const head = await fs.readFile(item.inputPath);
    if (job.type === 'pdf') {
      if (!isPdf(head)) throw new Error('This file does not contain a valid PDF signature.');
      item.result = await compressPdf(item.inputPath, item.outputPath, job.options.targetBytes, job.options.preset, job.options.grayscale);
    } else {
      if (isPdf(head)) throw new Error('This looks like a PDF, not an image. Choose the PDF compressor.');
      const meta = await sharp(item.inputPath, { failOn: 'error', limitInputPixels: 100_000_000 }).metadata();
      if (!meta.format || !['jpeg', 'png', 'webp', 'avif', 'heif', 'gif', 'tiff'].includes(meta.format)) throw new Error('Unsupported or invalid image content.');
      item.result = await compressImage(item.inputPath, item.outputPath, job.options);
    }
    item.status = 'done';
  } catch (error) {
    item.status = 'error';
    const message = error instanceof Error ? error.message : 'Compression failed.';
    item.error = message.includes('spawn gs ENOENT') || message.includes('ENOENT') ? 'PDF image optimization needs Ghostscript. Install Ghostscript or use the supplied Docker environment.' : message.slice(0, 300);
  }
}
async function runQueue() {
  while (running < CONCURRENCY && pending.length) {
    const job = pending.shift()!;
    running++;
    job.status = 'processing';
    void (async () => {
      try {
        for (const item of job.items) {
          if (job.cancelled) { item.status = 'cancelled'; continue; }
          await processItem(job, item);
          job.progress = Math.round(job.items.filter(file => ['done', 'error', 'cancelled'].includes(file.status)).length / job.items.length * 100);
        }
        job.status = job.cancelled ? 'cancelled' : job.items.some(item => item.status === 'done') ? 'done' : 'error';
      } finally { running--; void runQueue(); }
    })();
  }
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'squeezely-api', activeJobs: running, queuedJobs: pending.length }));
app.post('/api/jobs', upload.array('files', MAX_BATCH), async (req, res) => {
  const files = (req.files || []) as Express.Multer.File[];
  if (!files.length) return res.status(400).json({ error: 'Choose at least one file to compress.' });
  if (files.reduce((sum, file) => sum + file.size, 0) > 80 * 1024 * 1024) {
    await Promise.all(files.map(file => fs.rm(file.path, { force: true })));
    return res.status(413).json({ error: 'A batch must total 80 MB or less.' });
  }
  if (pending.length >= MAX_QUEUED_JOBS) {
    await Promise.all(files.map(file => fs.rm(file.path, { force: true })));
    return res.status(503).json({ error: 'The compression queue is busy. Please try again shortly.' });
  }
  const type = req.body.type === 'pdf' ? 'pdf' : 'image';
  const targetKb = numeric(req.body.targetKb, 5, 50_000, 200);
  const targetBytes = targetKb * 1024; // KB is defined as 1024 bytes throughout the app.
  const requestedFormat = String(req.body.format || 'webp').toLowerCase();
  const format = (['jpeg', 'jpg', 'png', 'webp', 'avif'].includes(requestedFormat) ? (requestedFormat === 'jpg' ? 'jpeg' : requestedFormat) : 'webp') as OutputFormat;
  const preset = (['balanced', 'quality', 'maximum'].includes(req.body.preset) ? req.body.preset : 'balanced') as Job['options']['preset'];
  const width = req.body.width ? numeric(req.body.width, 1, 20_000, 0) : undefined;
  const height = req.body.height ? numeric(req.body.height, 1, 20_000, 0) : undefined;
  const id = crypto.randomUUID();
  const folder = path.join(DATA_DIR, id);
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const items: Item[] = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const inputPath = path.join(folder, `input-${i}`);
    await fs.rename(file.path, inputPath);
    const sourceName = safeName(file.originalname);
    const extension = type === 'pdf' ? 'pdf' : imageExtension(format);
    const outputPath = path.join(folder, `output-${i}.${extension}`);
    items.push({ name: sourceName, inputPath, outputPath, status: 'queued' });
  }
  const job: Job = { id, createdAt: Date.now(), expiresAt: Date.now() + RETENTION_MS, type, status: 'queued', progress: 0, cancelled: false, items, options: { targetBytes, format, quality: numeric(req.body.quality, 25, 100, 82), width, height, preset, grayscale: req.body.grayscale === 'true' } };
  jobs.set(id, job);
  pending.push(job);
  void runQueue();
  res.status(202).json(serialize(job));
});
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'This job was not found or has expired.' });
  res.json(serialize(job));
});
app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'This job was not found or has expired.' });
  if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return res.status(409).json({ error: 'This job has already finished.' });
  job.cancelled = true;
  res.json({ ok: true });
});
app.post('/api/jobs/:id/retry/:index', async (req, res) => {
  const old = jobs.get(req.params.id); const index = Number(req.params.index);
  const item = old?.items[index];
  if (!old || !item || item.status !== 'error') return res.status(404).json({ error: 'No failed file was found to retry.' });
  if (Date.now() > old.expiresAt) return res.status(410).json({ error: 'This job has expired.' });
  const retryId = crypto.randomUUID();
  const retryFolder = path.join(DATA_DIR, retryId);
  await fs.mkdir(retryFolder, { recursive: true, mode: 0o700 });
  const retryItem: Item = { ...item, inputPath: path.join(retryFolder, 'input-0'), outputPath: path.join(retryFolder, `output-0${path.extname(item.outputPath)}`), status: 'queued', error: undefined, result: undefined };
  await fs.copyFile(item.inputPath, retryItem.inputPath);
  const retry: Job = { ...old, id: retryId, createdAt: Date.now(), expiresAt: Date.now() + RETENTION_MS, progress: 0, status: 'queued', cancelled: false, items: [retryItem], options: old.options };
  jobs.set(retry.id, retry); pending.push(retry); void runQueue();
  res.status(202).json(serialize(retry));
});
app.get('/api/jobs/:id/files/:index', async (req, res) => {
  const job = jobs.get(req.params.id); const index = Number(req.params.index); const item = job?.items[index];
  if (!job || !item || item.status !== 'done' || !item.result) return res.status(404).json({ error: 'The compressed file is not available.' });
  const downloadName = `${path.parse(item.name).name}-squeezely.${imageExtension(item.result.format)}`;
  if (req.query.preview === '1' && job.type === 'image') {
    res.setHeader('Content-Disposition', 'inline');
    return res.sendFile(item.outputPath);
  }
  res.download(item.outputPath, downloadName);
});
app.get('/api/jobs/:id/zip', async (req, res, next) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'This job was not found or has expired.' });
  const finished = job.items.filter(item => item.status === 'done' && item.result);
  if (!finished.length) return res.status(409).json({ error: 'There are no completed files to download yet.' });
  res.setHeader('Content-Type', 'application/zip'); res.setHeader('Content-Disposition', `attachment; filename="squeezely-${job.id.slice(0, 8)}.zip"`);
  const archive = archiver('zip', { zlib: { level: 6 } }); archive.on('error', next); archive.pipe(res);
  for (const item of finished) archive.file(item.outputPath, { name: `${path.parse(item.name).name}-squeezely.${imageExtension(item.result!.format)}` });
  await archive.finalize();
});

// Expire original and output files automatically; job IDs are unguessable and never expose storage paths.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.expiresAt < now && !['queued', 'processing'].includes(job.status)) {
    jobs.delete(id); void fs.rm(path.join(DATA_DIR, id), { recursive: true, force: true });
  }
  void (async () => {
    const incoming = path.join(DATA_DIR, 'incoming');
    for (const name of await fs.readdir(incoming).catch(() => [])) {
      const filePath = path.join(incoming, name); const details = await fs.stat(filePath).catch(() => undefined);
      if (details && now - details.mtimeMs > 15 * 60_000) await fs.rm(filePath, { force: true }).catch(() => undefined);
    }
  })();
  if (buckets.size > 10_000) for (const [ip, bucket] of buckets) if (now - bucket.started > 120_000) buckets.delete(ip);
}, 60_000).unref();

if (process.env.NODE_ENV === 'production') {
  const webRoot = path.resolve('dist');
  app.use(express.static(webRoot));
  app.use((req, res, next) => req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.startsWith('/files/') ? res.sendFile(path.join(webRoot, 'index.html')) : next());
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `Each file must be ${formatBytes(MAX_FILE_BYTES)} or smaller.` : `Upload limit exceeded (${MAX_BATCH} files maximum).` });
  const message = error instanceof Error ? error.message : 'Unexpected server error.';
  res.status(400).json({ error: message });
});
app.listen(PORT, '0.0.0.0', () => console.log(`Squeezely API listening on 0.0.0.0:${PORT}; max ${MAX_BATCH} files / ${formatBytes(MAX_FILE_BYTES)} each`));
