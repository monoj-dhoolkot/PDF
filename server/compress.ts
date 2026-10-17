import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp, { type OutputInfo, type Sharp } from 'sharp';
import { PDFDocument } from 'pdf-lib';

const execFileAsync = promisify(execFile);
export type OutputFormat = 'jpeg' | 'png' | 'webp' | 'avif';
export type ImageOptions = { targetBytes: number; format: OutputFormat; quality: number; width?: number; height?: number };
export type CompressionResult = { path: string; bytes: number; width?: number; height?: number; format: string; originalBytes: number; reduction: number; meetsTarget: boolean; warning?: string; pages?: number };

function encoder(pipeline: Sharp, format: OutputFormat, quality: number): Sharp {
  if (format === 'jpeg') return pipeline.jpeg({ quality, mozjpeg: true, progressive: true });
  if (format === 'webp') return pipeline.webp({ quality, effort: 5 });
  if (format === 'avif') return pipeline.avif({ quality, effort: 5 });
  return pipeline.png({ quality, compressionLevel: 9, palette: true, effort: 7 });
}

/** Finds the best quality candidate under a 2% safety margin; dimensions shrink only when quality alone is insufficient. */
export async function compressImage(inputPath: string, outputPath: string, options: ImageOptions): Promise<CompressionResult> {
  const originalBytes = (await fs.stat(inputPath)).size;
  const metadata = await sharp(inputPath, { failOn: 'error', limitInputPixels: 100_000_000 }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Could not read image dimensions.');
  const format = options.format;
  const target = Math.floor(options.targetBytes * 0.98);
  const startWidth = options.width ? Math.min(options.width, metadata.width) : metadata.width;
  const startHeight = options.height ? Math.min(options.height, metadata.height) : metadata.height;
  const scale = Math.min(startWidth / metadata.width, startHeight / metadata.height, 1);
  let width = Math.max(1, Math.round(metadata.width * scale));
  let height = Math.max(1, Math.round(metadata.height * scale));
  let best: { bytes: Buffer; info: OutputInfo; quality: number } | undefined;
  let smallest: { bytes: Buffer; info: OutputInfo; quality: number } | undefined;

  for (let dimensionPass = 0; dimensionPass < 10; dimensionPass++) {
    let low = 25;
    let high = Math.max(25, Math.min(100, options.quality));
    let passBest: typeof best;
    // Search toward the highest quality that meets the safety margin, capped to bound CPU time.
    for (let attempt = 0; attempt < 8 && low <= high; attempt++) {
      const q = Math.floor((low + high) / 2);
      try {
        const pipeline = sharp(inputPath, { failOn: 'error', limitInputPixels: 100_000_000 }).rotate().resize({ width, height, fit: 'inside', withoutEnlargement: true });
        if (format === 'jpeg' && metadata.hasAlpha) pipeline.flatten({ background: '#ffffff' });
        const { data, info } = await encoder(pipeline, format, q).toBuffer({ resolveWithObject: true });
        if (!smallest || data.length < smallest.bytes.length) smallest = { bytes: data, info, quality: q };
        if (data.length <= target) {
          if (!passBest || q > passBest.quality) passBest = { bytes: data, info, quality: q };
          low = q + 1;
        } else high = q - 1;
      } catch (error) {
        throw new Error(`Image encoding failed: ${error instanceof Error ? error.message : 'unsupported image format'}`);
      }
    }
    // Add the best fitting pass's output as an overall contender; first pass retains the largest dimensions.
    if (passBest) { best = passBest; break; }
    if (dimensionPass === 9 || (width <= 64 && height <= 64)) break;
    width = Math.max(64, Math.round(width * 0.84));
    height = Math.max(64, Math.round(height * 0.84));
  }
  const chosen = best ?? smallest;
  if (!chosen) throw new Error('Could not encode this image.');
  await fs.writeFile(outputPath, chosen.bytes, { mode: 0o600 });
  const meetsTarget = chosen.bytes.length <= options.targetBytes;
  const reduction = originalBytes ? Math.max(0, (1 - chosen.bytes.length / originalBytes) * 100) : 0;
  const dimensionsChanged = chosen.info.width < metadata.width || chosen.info.height < metadata.height;
  const warning = !meetsTarget
    ? `This image could not be reduced to ${formatBytes(options.targetBytes)} without extreme quality loss. The smallest tested result is shown.`
    : (dimensionsChanged ? 'The image was resized to help meet the target.' : undefined);
  return { path: outputPath, bytes: chosen.bytes.length, width: chosen.info.width, height: chosen.info.height, format, originalBytes, reduction, meetsTarget, warning };
}

export async function compressPdf(inputPath: string, outputPath: string, targetBytes: number, preset: 'balanced' | 'quality' | 'maximum', grayscale: boolean): Promise<CompressionResult> {
  const original = await fs.readFile(inputPath);
  const loaded = await PDFDocument.load(original, { ignoreEncryption: false, updateMetadata: false });
  const pages = loaded.getPageCount();
  if (pages < 1) throw new Error('The PDF has no pages.');
  const target = Math.floor(targetBytes * 0.98);
  // Rewriting with pdf-lib removes obsolete cross-reference/object data without rasterizing vector/text content.
  const clean = await loaded.save({ useObjectStreams: true, addDefaultPage: false, objectsPerTick: 50 });
  // Keep the input as a valid baseline: a lossless rewrite can occasionally make PDFs larger.
  const candidates = [original, clean];
  const gs = process.env.GHOSTSCRIPT_PATH || 'gs';
  let ghostscriptIssue: 'missing' | 'failed' | undefined;
  const settings = preset === 'quality' ? [{ dpi: 220, pdf: '/prepress', q: 90 }, { dpi: 160, pdf: '/ebook', q: 82 }]
    : preset === 'maximum' ? [{ dpi: 150, pdf: '/ebook', q: 78 }, { dpi: 96, pdf: '/screen', q: 65 }, { dpi: 72, pdf: '/screen', q: 50 }]
      : [{ dpi: 180, pdf: '/ebook', q: 82 }, { dpi: 120, pdf: '/ebook', q: 72 }, { dpi: 96, pdf: '/screen', q: 65 }];
  const tmpBase = `${outputPath}.gs`;
  try {
    for (const setting of settings) {
      const candidatePath = `${tmpBase}-${setting.dpi}.pdf`;
      const args = ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-sDEVICE=pdfwrite', `-dPDFSETTINGS=${setting.pdf}`, `-dColorImageResolution=${setting.dpi}`, `-dGrayImageResolution=${setting.dpi}`, `-dMonoImageResolution=${Math.max(setting.dpi, 300)}`, '-dDownsampleColorImages=true', '-dDownsampleGrayImages=true', '-dDetectDuplicateImages=true', '-dCompressFonts=true', '-dSubsetFonts=true', `-dJPEGQ=${setting.q}`, ...(grayscale ? ['-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray'] : []), `-sOutputFile=${candidatePath}`, inputPath];
      await execFileAsync(gs, args, { timeout: 90_000, maxBuffer: 2 * 1024 * 1024 });
      const data = await fs.readFile(candidatePath);
      const validation = await PDFDocument.load(data, { ignoreEncryption: false });
      if (validation.getPageCount() !== pages) throw new Error('The processed PDF did not preserve its page count.');
      candidates.push(data);
      await fs.rm(candidatePath, { force: true });
    }
  } catch (error) {
    // Preserve the valid input/rewrite if Ghostscript is not installed or cannot safely process this PDF.
    ghostscriptIssue = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'failed';
  } finally {
    await Promise.all((await fs.readdir(path.dirname(outputPath))).filter(name => name.startsWith(path.basename(tmpBase))).map(name => fs.rm(path.join(path.dirname(outputPath), name), { force: true }).catch(() => undefined)));
  }
  const fitting = candidates.filter(candidate => candidate.length <= target).sort((a, b) => b.length - a.length);
  const chosen = fitting[0] ?? candidates.reduce((smallest, candidate) => candidate.length < smallest.length ? candidate : smallest);
  await fs.writeFile(outputPath, chosen, { mode: 0o600 });
  const meetsTarget = chosen.length <= targetBytes;
  const warning = !meetsTarget && ghostscriptIssue === 'missing'
    ? `Ghostscript is not installed, so embedded PDF images could not be recompressed. Install Ghostscript or use Docker; the best valid lossless result (${formatBytes(chosen.length)}) is provided.`
    : !meetsTarget && ghostscriptIssue === 'failed'
      ? `The PDF is valid, but the image optimizer could not process it. The best valid result (${formatBytes(chosen.length)}) is provided; text and layout were preserved.`
      : !meetsTarget
        ? `The PDF could not be reduced to ${formatBytes(targetBytes)} without more destructive changes. Text and page layout were preserved.`
        : chosen === original
          ? 'This PDF was already within the requested size, so its contents were left unchanged.'
          : undefined;
  return { path: outputPath, bytes: chosen.length, format: 'pdf', originalBytes: original.length, reduction: Math.max(0, (1 - chosen.length / original.length) * 100), meetsTarget, pages, warning };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
