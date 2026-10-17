import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { compressImage, compressPdf } from '../server/compress';

describe('real file compression', () => {
  it('encodes a valid image and verifies target bytes', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'squeezely-test-'));
    try {
      const input = path.join(dir, 'fixture.png'); const output = path.join(dir, 'output.webp');
      const pixels = Buffer.alloc(600 * 400 * 3);
      for (let i = 0; i < pixels.length; i += 3) { pixels[i] = (i / 3) % 256; pixels[i + 1] = ((i / 3) * 13) % 256; pixels[i + 2] = 180; }
      await sharp(pixels, { raw: { width: 600, height: 400, channels: 3 } }).png().toFile(input);
      const result = await compressImage(input, output, { targetBytes: 80 * 1024, format: 'webp', quality: 82 });
      expect((await stat(output)).size).toBe(result.bytes);
      expect((await sharp(await readFile(output)).metadata()).format).toBe('webp');
      expect(result.meetsTarget).toBe(result.bytes <= 80 * 1024);
      expect(result.width).toBe(600);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rewrites and validates a PDF without changing its page count or growing it', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'squeezely-pdf-test-'));
    const oldGs = process.env.GHOSTSCRIPT_PATH;
    try {
      process.env.GHOSTSCRIPT_PATH = path.join(dir, 'ghostscript-not-installed');
      const input = path.join(dir, 'fixture.pdf'); const output = path.join(dir, 'output.pdf');
      const doc = await PDFDocument.create(); doc.addPage([612, 792]); doc.addPage([420, 595]);
      await writeFile(input, await doc.save());
      const result = await compressPdf(input, output, 1024 * 1024, 'balanced', false);
      const check = await PDFDocument.load(await readFile(output));
      expect(check.getPageCount()).toBe(2); expect(result.pages).toBe(2);
      expect(result.meetsTarget).toBe(true);
      expect(result.bytes).toBeLessThanOrEqual(result.originalBytes);
    } finally {
      if (oldGs === undefined) delete process.env.GHOSTSCRIPT_PATH; else process.env.GHOSTSCRIPT_PATH = oldGs;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns a valid downloadable-sized PDF and clearly warns if target is impossible without Ghostscript', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'squeezely-pdf-fallback-'));
    const oldGs = process.env.GHOSTSCRIPT_PATH;
    try {
      process.env.GHOSTSCRIPT_PATH = path.join(dir, 'ghostscript-not-installed');
      const input = path.join(dir, 'fixture.pdf'); const output = path.join(dir, 'output.pdf');
      const doc = await PDFDocument.create(); doc.addPage([612, 792]);
      await writeFile(input, await doc.save());
      const result = await compressPdf(input, output, 5, 'balanced', false);
      expect(result.meetsTarget).toBe(false);
      expect(result.warning).toContain('Ghostscript is not installed');
      expect((await PDFDocument.load(await readFile(output))).getPageCount()).toBe(1);
      expect((await stat(output)).size).toBe(result.bytes);
    } finally {
      if (oldGs === undefined) delete process.env.GHOSTSCRIPT_PATH; else process.env.GHOSTSCRIPT_PATH = oldGs;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
