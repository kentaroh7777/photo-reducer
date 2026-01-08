#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import dayjs from "dayjs";
import sharp from "sharp";
import fg from "fast-glob";
import fsExtra from "fs-extra";

type MetadataRecord = {
  lastProcessedAt: string;
  lastRate: number;
};

type CliOptions = {
  source?: string;
  output?: string;
  rate: number;
  since?: string;
  fromNow?: boolean;
  maxOutputWidth?: number;
  pngFormat: "png" | "webp" | "avif";
  watch?: boolean;
  interval: number;
  file?: string;
};

const SUPPORTED_GLOBS = [
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.png",
  "**/*.webp",
  "**/*.tif",
  "**/*.tiff",
  "**/*.avif",
  "**/*.gif",
  "**/*.heic",
];

const program = new Command()
  .name("photo-reducer")
  .description("指定ディレクトリ内の画像を縮小して出力します")
  .option("--source <path>", "処理対象ディレクトリ")
  .option("--output <path>", "縮小画像の出力先ディレクトリ")
  .option("--rate <number>", "縮小率（0より大きく1以下）", (value) => parseFloat(value), 0.9)
  .option("--since <since>", "指定日時以降の更新のみ処理（ISO 8601 または YYYY-M-D）")
  .option("--from-now", "今この瞬間を基準に開始する（初回: .photo-reducer が無い場合のデフォルト）")
  .option("--max-output-width <px>", "出力画像の最大横幅（ピクセル）", (value) => parseInt(value, 10))
  .option(
    "--png-format <png|webp|avif>",
    "入力がPNGの場合の出力形式（デフォルト: png）。webp/avif を指定すると拡張子も変わります",
    (value) => value,
    "png",
  )
  .option("--watch", "監視モード（定期的に処理）")
  .option("--interval <seconds>", "監視時の間隔（秒）", (value) => parseFloat(value), 60)
  .option("--file <path>", "個別ファイルを単独で縮小（.photo-reducer は更新しない）")
  .helpOption("-h, --help", "ヘルプを表示");

async function main(): Promise<void> {
  // `... | head` のように stdout が途中で閉じられても、EPIPEで落ちないようにする
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      process.exit(0);
    }
  });

  const options = program.parse().opts<CliOptions>();
  try {
    await validateAndExecute(options);
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}

function parseSince(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  // YYYY-M-D の場合は「その日の 0:00 JST 以降」として扱う
  const ymdMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (ymdMatch) {
    const year = Number(ymdMatch[1]);
    const month = Number(ymdMatch[2]);
    const day = Number(ymdMatch[3]);
    if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
      throw new Error("`--since` の日付が不正です（YYYY-M-D）");
    }
    // JST 0:00 は UTC では前日 15:00
    const utcMs = Date.UTC(year, month - 1, day, 0, 0, 0) - 9 * 60 * 60 * 1000;
    const date = new Date(utcMs);
    // 入力値に対応する日付として妥当かチェック（例: 2026-2-30 はNG）
    const check = new Date(utcMs + 9 * 60 * 60 * 1000);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      throw new Error("`--since` の日付が不正です（YYYY-M-D）");
    }
    return date;
  }

  const parsed = dayjs(value);
  if (!parsed.isValid()) {
    throw new Error("`--since` はISO 8601 または YYYY-M-D 形式で指定してください");
  }
  return parsed.toDate();
}

function validateRate(rate: number): number {
  if (Number.isFinite(rate) && rate > 0 && rate <= 1) {
    return rate;
  }
  throw new Error("--rate には0より大きく1以下の数字を指定してください");
}

function validateMaxOutputWidth(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error("--max-output-width には1以上の整数を指定してください");
}

function validatePngFormat(value: string): "png" | "webp" | "avif" {
  if (value === "png" || value === "webp" || value === "avif") {
    return value;
  }
  throw new Error("--png-format には png / webp / avif を指定してください");
}

function formatForLog(date: Date): string {
  return dayjs(date).format("YYYY-MM-DDTHH:mm:ssZ");
}

async function validateAndExecute(options: CliOptions): Promise<void> {
  const rate = validateRate(options.rate);
  const maxOutputWidth = validateMaxOutputWidth(options.maxOutputWidth);
  const pngFormat = validatePngFormat(options.pngFormat);
  if (options.file) {
    if (!options.output) {
      throw new Error("--output は単一ファイルモードでも必須です");
    }
    await handleSingleFileMode(options.file, options.output, rate, maxOutputWidth, pngFormat);
    return;
  }

  if (!options.source || !options.output) {
    throw new Error("--source と --output はディレクトリ処理で必須です");
  }

  const sourceDir = path.resolve(options.source);
  const outputDir = path.resolve(options.output);
  const metadataPath = path.join(sourceDir, ".photo-reducer");
  const sinceOverride = parseSince(options.since);
  const fromNowOverride = options.fromNow ? new Date() : undefined;
  const effectiveSinceOverride = fromNowOverride ?? sinceOverride;
  const forceBaselineWrite = Boolean(fromNowOverride);
  await fsExtra.ensureDir(outputDir);

  if (options.watch) {
    await startWatchMode({
      sourceDir,
      outputDir,
      rate,
      maxOutputWidth,
      pngFormat,
      metadataPath,
      sinceOverride: effectiveSinceOverride,
      forceBaselineWrite,
      intervalSeconds: options.interval,
    });
    return;
  }

  const result = await runBatchProcess(sourceDir, outputDir, rate, maxOutputWidth, pngFormat, metadataPath, {
    logMode: "always",
    forceBaselineWrite,
  }, effectiveSinceOverride);
  if (result.shouldWriteMetadata) {
    await writeMetadata(metadataPath, result.updatedLastProcessedAt, rate);
  }
}

async function handleSingleFileMode(
  filePath: string,
  outputDir: string,
  rate: number,
  maxOutputWidth: number | undefined,
  pngFormat: "png" | "webp" | "avif",
): Promise<void> {
  const absoluteFile = path.resolve(filePath);
  const stats = await fs.promises.stat(absoluteFile);
  if (!stats.isFile()) {
    throw new Error("指定されたパスはファイルではありません");
  }
  const relativeName = path.basename(absoluteFile);
  const out = getOutputPaths(relativeName, pngFormat);
  const destination = path.join(path.resolve(outputDir), out.primaryRelativePath);
  const fallbackDestination = path.join(path.resolve(outputDir), out.fallbackRelativePath);
  const result = await shrinkImage(absoluteFile, destination, fallbackDestination, rate, maxOutputWidth, pngFormat);
  console.log(
    `${relativeName} → ${path.basename(result.writtenPath)} : ${result.originalSize}B → ${result.optimizedSize}B`,
  );
}

async function startWatchMode(params: {
  sourceDir: string;
  outputDir: string;
  rate: number;
  maxOutputWidth?: number;
  pngFormat: "png" | "webp" | "avif";
  metadataPath: string;
  sinceOverride?: Date;
  forceBaselineWrite: boolean;
  intervalSeconds: number;
}): Promise<void> {
  console.log("監視モードを開始します");
  let processing = false;
  let sinceForWatch = params.sinceOverride;
  const intervalMs = Math.max(1000, Math.floor(params.intervalSeconds * 1000));

  const cycle = async (): Promise<void> => {
    if (processing) {
      return;
    }
    processing = true;
    try {
      const result = await runBatchProcess(
        params.sourceDir,
        params.outputDir,
        params.rate,
        params.maxOutputWidth,
        params.pngFormat,
        params.metadataPath,
        {
          logMode: "ifProcessed",
          forceBaselineWrite: params.forceBaselineWrite,
        },
        sinceForWatch,
      );
      if (result.shouldWriteMetadata) {
        await writeMetadata(params.metadataPath, result.updatedLastProcessedAt, params.rate);
        // 監視モードで --since / --from-now を指定している場合は、同じファイルを再処理し続けないように基準を進める
        if (sinceForWatch) {
          sinceForWatch = result.updatedLastProcessedAt;
        }
      }
    } catch (error) {
      console.error("[DEBUG] 監視サイクルでエラーが発生しました:", (error as Error).message);
    } finally {
      processing = false;
    }
  };

  await cycle();

  const intervalId = setInterval(() => {
    void cycle();
  }, intervalMs);

  const shutdown = () => {
    clearInterval(intervalId);
    console.log("監視モードを終了します");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runBatchProcess(
  sourceDir: string,
  outputDir: string,
  rate: number,
  maxOutputWidth: number | undefined,
  pngFormat: "png" | "webp" | "avif",
  metadataPath: string,
  options: { logMode: "always" | "ifProcessed"; forceBaselineWrite: boolean },
  sinceOverride?: Date,
): Promise<{ processedCount: number; updatedLastProcessedAt: Date; shouldWriteMetadata: boolean }> {
  const metadataResult = await readMetadata(metadataPath);
  const recordedAt = new Date(metadataResult.record.lastProcessedAt);
  const sinceDate = determineSince(recordedAt, sinceOverride);
  if (options.logMode === "always") {
    console.log(
      `処理を開始します: ${sourceDir} → ${outputDir}（since=${formatForLog(sinceDate)}）`,
    );
  }

  const result = await processDirectory(sourceDir, outputDir, sinceDate, rate, maxOutputWidth, pngFormat, {
    logMode: options.logMode,
    sourceDir,
    outputDir,
  });

  const shouldWriteMetadata =
    result.processedCount > 0 ||
    !metadataResult.existed ||
    options.forceBaselineWrite;

  const updatedLastProcessedAt = computeUpdatedLastProcessedAt({
    recordedAt,
    latestProcessedAt: result.latestProcessedAt,
    processedCount: result.processedCount,
    sinceOverride,
    shouldWriteMetadata,
  });

  return {
    processedCount: result.processedCount,
    updatedLastProcessedAt,
    shouldWriteMetadata,
  };
}

function determineSince(recordedAt: Date, override?: Date): Date {
  return override ?? recordedAt;
}

async function processDirectory(
  sourceDir: string,
  outputDir: string,
  sinceDate: Date,
  rate: number,
  maxOutputWidth: number | undefined,
  pngFormat: "png" | "webp" | "avif",
  logContext: { logMode: "always" | "ifProcessed"; sourceDir: string; outputDir: string },
): Promise<{ latestProcessedAt: Date; processedCount: number }> {
  const options = {
    cwd: sourceDir,
    absolute: true,
    onlyFiles: true,
    suppressErrors: true,
    unique: true,
    caseSensitiveMatch: false,
  };
  const entries = await fg(SUPPORTED_GLOBS, options);
  let latestProcessedAt = sinceDate;
  let processedCount = 0;
  let startedLogged = logContext.logMode === "always";

  for (const filePath of entries) {
    const stats = await fs.promises.stat(filePath);
    if (!stats.isFile()) {
      continue;
    }
    if (stats.mtime <= sinceDate) {
      continue;
    }
    const relative = path.relative(sourceDir, filePath);
    const out = getOutputPaths(relative, pngFormat);
    const destination = path.join(outputDir, out.primaryRelativePath);
    const fallbackDestination = path.join(outputDir, out.fallbackRelativePath);
    try {
      if (!startedLogged) {
        console.log(
          `処理を開始します: ${logContext.sourceDir} → ${logContext.outputDir}（since=${formatForLog(sinceDate)}）`,
        );
        startedLogged = true;
      }
      const result = await shrinkImage(
        filePath,
        destination,
        fallbackDestination,
        rate,
        maxOutputWidth,
        pngFormat,
      );
      processedCount += 1;
      latestProcessedAt = stats.mtime > latestProcessedAt ? stats.mtime : latestProcessedAt;
      console.log(
        `${relative} : ${result.originalSize}B → ${result.optimizedSize}B (${Math.round(
          (result.optimizedSize / result.originalSize) * 100,
        )}%)`,
      );
    } catch (error) {
      console.error(`"${relative}" の処理中にエラー発生:`, (error as Error).message);
    }
  }

  if (logContext.logMode === "always" || processedCount > 0) {
    console.log(`合計 ${processedCount} 件を処理しました`);
  }
  return { latestProcessedAt, processedCount };
}

function maxDate(a: Date, b: Date): Date {
  return a > b ? a : b;
}

function computeUpdatedLastProcessedAt(params: {
  recordedAt: Date;
  latestProcessedAt: Date;
  processedCount: number;
  sinceOverride?: Date;
  shouldWriteMetadata: boolean;
}): Date {
  if (!params.shouldWriteMetadata) {
    return params.recordedAt;
  }
  if (params.processedCount === 0) {
    // 初回作成や --from-now の明示指定時など、処理0件でも基準を固定したいケース
    return params.sinceOverride ?? params.recordedAt;
  }
  return maxDate(params.recordedAt, params.latestProcessedAt);
}

async function shrinkImage(
  sourcePath: string,
  targetPath: string,
  fallbackTargetPath: string,
  rate: number,
  maxOutputWidth: number | undefined,
  pngFormat: "png" | "webp" | "avif",
): Promise<{
  originalSize: number;
  optimizedSize: number;
  writtenPath: string;
}> {
  await fsExtra.ensureDir(path.dirname(targetPath));
  await fsExtra.ensureDir(path.dirname(fallbackTargetPath));
  const originalStats = await fs.promises.stat(sourcePath);
  const metadata = await sharp(sourcePath).metadata();
  const resize = computeResize(metadata.width, metadata.height, rate, maxOutputWidth);
  const width = resize?.width;
  const height = resize?.height;

  const pipeline = sharp(sourcePath);
  if (width || height) {
    pipeline.resize({ width, height });
  }

  const quality = clampQuality(rate);
  switch (metadata.format) {
    case "jpeg":
    case "jpg":
      pipeline.jpeg({ quality });
      break;
    case "webp":
      pipeline.webp({ quality });
      break;
    case "png":
      if (pngFormat === "webp") {
        pipeline.webp({ quality });
      } else if (pngFormat === "avif") {
        pipeline.avif({ quality });
      } else {
        pipeline.png({ compressionLevel: 9 });
      }
      break;
    case "avif":
      pipeline.avif({ quality });
      break;
    case "heif":
      pipeline.heif?.({ quality });
      break;
  }

  const tmpPath = `${targetPath}.tmp`;
  await pipeline.toFile(tmpPath);
  const optimizedStats = await fs.promises.stat(tmpPath);
  if (optimizedStats.size >= originalStats.size) {
    // 逆に大きくなる場合は置き換えない（元をそのまま出力）
    await fsExtra.remove(tmpPath);
    await fsExtra.copyFile(sourcePath, fallbackTargetPath);
    const fallbackStats = await fs.promises.stat(fallbackTargetPath);
    return {
      originalSize: originalStats.size,
      optimizedSize: fallbackStats.size,
      writtenPath: fallbackTargetPath,
    };
  }
  await fsExtra.move(tmpPath, targetPath, { overwrite: true });
  return {
    originalSize: originalStats.size,
    optimizedSize: optimizedStats.size,
    writtenPath: targetPath,
  };
}

function getOutputPaths(
  relativePath: string,
  pngFormat: "png" | "webp" | "avif",
): { primaryRelativePath: string; fallbackRelativePath: string } {
  const ext = path.extname(relativePath).toLowerCase();
  const base = relativePath.slice(0, relativePath.length - ext.length);
  const fallbackRelativePath = relativePath;
  if (ext === ".png") {
    if (pngFormat === "webp") {
      return { primaryRelativePath: `${base}.webp`, fallbackRelativePath };
    }
    if (pngFormat === "avif") {
      return { primaryRelativePath: `${base}.avif`, fallbackRelativePath };
    }
  }
  return { primaryRelativePath: relativePath, fallbackRelativePath };
}

function computeResize(
  sourceWidth: number | undefined,
  sourceHeight: number | undefined,
  rate: number,
  maxOutputWidth: number | undefined,
): { width?: number; height?: number } | undefined {
  if (!sourceWidth || !sourceHeight) {
    return undefined;
  }

  const scaledWidth = Math.max(1, Math.round(sourceWidth * rate));
  const limitedWidth = maxOutputWidth ? Math.min(scaledWidth, maxOutputWidth) : scaledWidth;
  const appliedRate = limitedWidth / sourceWidth;
  const scaledHeight = Math.max(1, Math.round(sourceHeight * appliedRate));
  return { width: limitedWidth, height: scaledHeight };
}

function clampQuality(rate: number): number {
  return Math.max(30, Math.min(90, Math.round(rate * 100)));
}

async function readMetadata(metadataPath: string): Promise<{ record: MetadataRecord; existed: boolean }> {
  try {
    const raw = await fs.promises.readFile(metadataPath, "utf-8");
    return { record: JSON.parse(raw) as MetadataRecord, existed: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        record: {
          lastProcessedAt: new Date().toISOString(),
          lastRate: 0.9,
        },
        existed: false,
      };
    }
    throw error;
  }
}

async function writeMetadata(metadataPath: string, lastProcessedAt: Date, rate: number): Promise<void> {
  const payload: MetadataRecord = {
    lastProcessedAt: lastProcessedAt.toISOString(),
    lastRate: rate,
  };
  const tmpPath = `${metadataPath}.tmp`;
  await fs.promises.writeFile(tmpPath, JSON.stringify(payload, null, 2), "utf-8");
  await fs.promises.rename(tmpPath, metadataPath);
}

void main();

