import type { CellState, Grid } from "./types";
import { getCachedWords } from "./wordData";
import { createEmptyGrid, MAX_GUESSES, WORD_LENGTH } from "./wordle";

type TesseractModule = typeof import("tesseract.js");
type TesseractWorker = Awaited<ReturnType<TesseractModule["createWorker"]>>;
type TesseractPsm = TesseractModule["PSM"];

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Span {
  start: number;
  end: number;
  width: number;
  center: number;
}

interface TileBox {
  row: number;
  col: number;
  left: number;
  top: number;
  size: number;
}

export interface RecognitionProgress {
  phase: "image" | "ocr" | "done";
  message: string;
  progress: number;
}

export interface RecognizedBoard {
  grid: Grid;
  warnings: string[];
}

const COLOR_REFS: Record<Exclude<CellState, "blank">, Rgb[]> = {
  correct: [
    { r: 106, g: 170, b: 100 },
    { r: 83, g: 141, b: 78 },
  ],
  present: [
    { r: 201, g: 180, b: 88 },
    { r: 181, g: 159, b: 59 },
  ],
  absent: [
    { r: 120, g: 124, b: 126 },
    { r: 58, g: 58, b: 60 },
  ],
};

const COLOR_THRESHOLD = 62;
const MIN_COLOR_RATIO = 0.18;

export async function recognizeBoardFromImage(
  file: Blob,
  onProgress?: (progress: RecognitionProgress) => void,
): Promise<RecognizedBoard> {
  onProgress?.({ phase: "image", message: "이미지 분석", progress: 0.05 });

  const canvas = await blobToCanvas(file);
  const boxes = detectGridBoxes(canvas);
  const imageData = getCanvasImageData(canvas);
  const grid = createEmptyGrid();

  for (const box of boxes) {
    const samples = sampleBox(imageData, canvas.width, canvas.height, box);
    grid[box.row][box.col] = {
      letter: "",
      state: classifyTileColorFromSamples(samples),
    };
  }

  const warnings: string[] = [];
  const filledBoxes = boxes.filter((box) => grid[box.row][box.col].state !== "blank");
  if (filledBoxes.length === 0) {
    return { grid, warnings: ["색상이 있는 Wordle 칸을 찾지 못했습니다."] };
  }

  try {
    await recognizeLetters(canvas, filledBoxes, grid, onProgress);
    await correctRecognizedWords(grid);
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : "OCR 처리 중 오류가 발생했습니다.");
  }

  onProgress?.({ phase: "done", message: "완료", progress: 1 });
  return { grid, warnings };
}

async function correctRecognizedWords(grid: Grid): Promise<void> {
  const words = await getCachedWords();
  const wordSet = new Set(words);

  for (const row of grid) {
    if (row.some((cell) => cell.state === "blank" || !cell.letter)) {
      continue;
    }

    const recognized = row.map((cell) => cell.letter).join("").toLowerCase();
    if (wordSet.has(recognized)) {
      continue;
    }

    const corrected = findClosestWord(recognized, row.map((cell) => cell.confidence ?? 0), words);
    if (!corrected) {
      continue;
    }

    for (let index = 0; index < WORD_LENGTH; index += 1) {
      row[index] = {
        ...row[index],
        letter: corrected[index].toUpperCase(),
      };
    }
  }
}

function findClosestWord(
  recognized: string,
  confidences: number[],
  words: string[],
): string | null {
  let best: { word: string; cost: number } | null = null;

  for (const word of words) {
    let differences = 0;
    let cost = 0;

    for (let index = 0; index < WORD_LENGTH; index += 1) {
      if (word[index] === recognized[index]) {
        continue;
      }
      differences += 1;
      const confidence = confidences[index] ?? 0;
      cost += 1 + confidence / 100;
    }

    if (differences === 0 || differences > 2) {
      continue;
    }

    if (!best || cost < best.cost) {
      best = { word, cost };
    }
  }

  return best && best.cost <= 2.2 ? best.word : null;
}

export function classifyTileColorFromSamples(samples: Rgb[]): CellState {
  if (samples.length === 0) {
    return "blank";
  }

  const ratios = {
    correct: colorRatio(samples, COLOR_REFS.correct),
    present: colorRatio(samples, COLOR_REFS.present),
    absent: colorRatio(samples, COLOR_REFS.absent),
  };

  const ordered = Object.entries(ratios).sort((a, b) => b[1] - a[1]) as Array<
    [Exclude<CellState, "blank">, number]
  >;
  const [state, ratio] = ordered[0];

  return ratio >= MIN_COLOR_RATIO ? state : "blank";
}

function colorRatio(samples: Rgb[], refs: Rgb[]): number {
  let hits = 0;
  for (const sample of samples) {
    const nearest = nearestTileState(sample);
    if (nearest && COLOR_REFS[nearest] === refs) {
      hits += 1;
    }
  }
  return hits / samples.length;
}

function colorDistance(a: Rgb, b: Rgb): number {
  return Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
}

function isFilledTilePixel(pixel: Rgb): boolean {
  return nearestTileState(pixel) !== null;
}

function nearestTileState(pixel: Rgb): Exclude<CellState, "blank"> | null {
  let nearest: Exclude<CellState, "blank"> | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const [state, refs] of Object.entries(COLOR_REFS) as Array<
    [Exclude<CellState, "blank">, Rgb[]]
  >) {
    for (const ref of refs) {
      const distance = colorDistance(pixel, ref);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = state;
      }
    }
  }

  return nearestDistance <= COLOR_THRESHOLD ? nearest : null;
}

async function blobToCanvas(file: Blob): Promise<HTMLCanvasElement> {
  if ("createImageBitmap" in window) {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("Canvas를 초기화할 수 없습니다.");
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return canvas;
  }

  const image = await blobToImage(file);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas를 초기화할 수 없습니다.");
  }
  ctx.drawImage(image, 0, 0);
  return canvas;
}

function blobToImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 불러오지 못했습니다."));
    };
    image.src = url;
  });
}

function getCanvasImageData(canvas: HTMLCanvasElement): ImageData {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("Canvas 데이터를 읽을 수 없습니다.");
  }
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function detectGridBoxes(canvas: HTMLCanvasElement): TileBox[] {
  const imageData = getCanvasImageData(canvas);
  const xCounts = Array.from({ length: canvas.width }, () => 0);
  const yCounts = Array.from({ length: canvas.height }, () => 0);

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const pixel = getPixel(imageData, canvas.width, x, y);
      if (isFilledTilePixel(pixel)) {
        xCounts[x] += 1;
        yCounts[y] += 1;
      }
    }
  }

  const xSpans = topSpans(
    spansFromProjection(xCounts, Math.max(10, canvas.height * 0.045), 18),
    WORD_LENGTH,
  ).sort((a, b) => a.start - b.start);
  const ySpans = topSpans(
    spansFromProjection(yCounts, Math.max(10, canvas.width * 0.1), 18),
    MAX_GUESSES,
  ).sort((a, b) => a.start - b.start);

  if (xSpans.length !== WORD_LENGTH || ySpans.length === 0) {
    throw new Error("Wordle 그리드 위치를 찾지 못했습니다.");
  }

  const tileSize = Math.round(median(xSpans.map((span) => span.width)));
  const xCenters = xSpans.map((span) => span.center);
  const xGap = median(gapsBetweenSpans(xSpans)) || Math.max(4, tileSize * 0.08);
  const rowPitch =
    ySpans.length >= 2
      ? median(ySpans.slice(1).map((span, index) => span.center - ySpans[index].center))
      : tileSize + xGap;
  const firstRowCenter = ySpans[0].center;

  const boxes: TileBox[] = [];
  for (let row = 0; row < MAX_GUESSES; row += 1) {
    const centerY = firstRowCenter + rowPitch * row;
    for (let col = 0; col < WORD_LENGTH; col += 1) {
      boxes.push({
        row,
        col,
        left: Math.round(xCenters[col] - tileSize / 2),
        top: Math.round(centerY - tileSize / 2),
        size: tileSize,
      });
    }
  }

  return boxes;
}

function spansFromProjection(counts: number[], minCount: number, minWidth: number): Span[] {
  const spans: Span[] = [];
  let start: number | null = null;

  for (let index = 0; index <= counts.length; index += 1) {
    const active = index < counts.length && counts[index] >= minCount;
    if (active && start === null) {
      start = index;
    } else if (!active && start !== null) {
      const end = index - 1;
      const width = end - start + 1;
      if (width >= minWidth) {
        spans.push({ start, end, width, center: (start + end) / 2 });
      }
      start = null;
    }
  }

  return spans;
}

function topSpans(spans: Span[], count: number): Span[] {
  return [...spans].sort((a, b) => b.width - a.width).slice(0, count);
}

function gapsBetweenSpans(spans: Span[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < spans.length; index += 1) {
    gaps.push(spans[index].start - spans[index - 1].end - 1);
  }
  return gaps.filter((gap) => gap > 0);
}

function sampleBox(
  imageData: ImageData,
  imageWidth: number,
  imageHeight: number,
  box: TileBox,
): Rgb[] {
  const samples: Rgb[] = [];
  const inset = Math.max(4, Math.round(box.size * 0.16));
  const step = Math.max(2, Math.round(box.size / 28));
  const left = clamp(box.left + inset, 0, imageWidth - 1);
  const right = clamp(box.left + box.size - inset, 0, imageWidth - 1);
  const top = clamp(box.top + inset, 0, imageHeight - 1);
  const bottom = clamp(box.top + box.size - inset, 0, imageHeight - 1);

  for (let y = top; y <= bottom; y += step) {
    for (let x = left; x <= right; x += step) {
      samples.push(getPixel(imageData, imageWidth, x, y));
    }
  }

  return samples;
}

async function recognizeLetters(
  source: HTMLCanvasElement,
  boxes: TileBox[],
  grid: Grid,
  onProgress?: (progress: RecognitionProgress) => void,
): Promise<void> {
  const Tesseract = await import("tesseract.js");
  const worker = await Tesseract.createWorker("eng", Tesseract.OEM.DEFAULT, {
    logger: (message) => {
      if (message.status === "recognizing text") {
        onProgress?.({
          phase: "ocr",
          message: "글자 인식",
          progress: 0.25 + message.progress * 0.5,
        });
      }
    },
  });

  try {
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_CHAR,
      user_defined_dpi: "160",
    });

    for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index];
      const result = await recognizeCellLetter(worker, source, box, Tesseract.PSM);
      const shapeLetter = result.letter ? "" : guessLetterByShape(source, box);

      grid[box.row][box.col] = {
        ...grid[box.row][box.col],
        letter: result.letter || shapeLetter,
        confidence: result.confidence,
      };

      onProgress?.({
        phase: "ocr",
        message: "글자 인식",
        progress: 0.75 + ((index + 1) / boxes.length) * 0.2,
      });
    }
  } finally {
    await worker.terminate();
  }
}

async function recognizeCellLetter(
  worker: TesseractWorker,
  source: HTMLCanvasElement,
  box: TileBox,
  psm: TesseractPsm,
): Promise<{ letter: string; confidence: number }> {
  const variants = createLetterCanvases(source, box);
  let best = { letter: "", confidence: 0 };

  for (const mode of [psm.SINGLE_CHAR, psm.SINGLE_WORD]) {
    await worker.setParameters({ tessedit_pageseg_mode: mode });
    for (const canvas of variants) {
      const result = await worker.recognize(canvas);
      const letter = result.data.text.toUpperCase().match(/[A-Z]/)?.[0] ?? "";
      const confidence = Number.isFinite(result.data.confidence) ? result.data.confidence : 0;
      if (letter && confidence > best.confidence) {
        best = { letter, confidence };
      }
      if (letter && confidence >= 45) {
        return best;
      }
    }
  }

  return best.confidence >= 30 ? best : { letter: "", confidence: best.confidence };
}

function createLetterCanvases(source: HTMLCanvasElement, box: TileBox): HTMLCanvasElement[] {
  return [
    cropLetterCanvas(source, box, { insetRatio: 0.08, padding: 0, binary: true, size: 128 }),
    cropLetterCanvas(source, box, { insetRatio: 0, padding: 0, binary: true, size: 128 }),
    cropLetterCanvas(source, box, { insetRatio: 0, padding: 18, binary: true, size: 128 }),
    cropLetterCanvas(source, box, { insetRatio: 0.08, padding: 0, binary: false, size: 128 }),
  ];
}

function cropLetterCanvas(
  source: HTMLCanvasElement,
  box: TileBox,
  options: { insetRatio: number; padding: number; binary: boolean; size: number },
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  const size = options.size;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("OCR 캔버스를 초기화할 수 없습니다.");
  }

  const inset = Math.round(box.size * options.insetRatio);
  const destinationSize = size - options.padding * 2;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(
    source,
    box.left + inset,
    box.top + inset,
    box.size - inset * 2,
    box.size - inset * 2,
    options.padding,
    options.padding,
    destinationSize,
    destinationSize,
  );

  if (!options.binary) {
    return canvas;
  }

  const image = ctx.getImageData(0, 0, size, size);
  for (let index = 0; index < image.data.length; index += 4) {
    const r = image.data[index];
    const g = image.data[index + 1];
    const b = image.data[index + 2];
    const isLetter = r > 175 && g > 175 && b > 175;
    const value = isLetter ? 0 : 255;
    image.data[index] = value;
    image.data[index + 1] = value;
    image.data[index + 2] = value;
    image.data[index + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  return canvas;
}

function guessLetterByShape(source: HTMLCanvasElement, box: TileBox): string {
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return "";
  }

  const image = ctx.getImageData(box.left, box.top, box.size, box.size);
  const points: Array<{ x: number; y: number }> = [];
  const margin = Math.round(box.size * 0.08);

  for (let y = margin; y < box.size - margin; y += 1) {
    for (let x = margin; x < box.size - margin; x += 1) {
      const index = (y * box.size + x) * 4;
      const r = image.data[index];
      const g = image.data[index + 1];
      const b = image.data[index + 2];
      if (r > 175 && g > 175 && b > 175) {
        points.push({ x, y });
      }
    }
  }

  return classifyLetterShape(points, box.size);
}

export function classifyLetterShape(
  points: Array<{ x: number; y: number }>,
  tileSize: number,
): string {
  if (points.length < tileSize * 1.45) {
    return "";
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const aspect = width / height;
  const fill = points.length / (width * height);

  if (aspect < 0.45 && height > tileSize * 0.36 && fill > 0.42) {
    return "I";
  }

  if (aspect >= 0.68 && aspect <= 1.22 && fill >= 0.22 && fill <= 0.7) {
    const center = ratioInRegion(
      points,
      minX + width * 0.34,
      maxX - width * 0.34,
      minY + height * 0.34,
      maxY - height * 0.34,
    );
    if (center < 0.1) {
      return "O";
    }
  }

  return "";
}

function ratioInRegion(
  points: Array<{ x: number; y: number }>,
  left: number,
  right: number,
  top: number,
  bottom: number,
): number {
  const area = Math.max(1, (right - left + 1) * (bottom - top + 1));
  const count = points.filter(
    (point) => point.x >= left && point.x <= right && point.y >= top && point.y <= bottom,
  ).length;
  return count / area;
}

function getPixel(imageData: ImageData, width: number, x: number, y: number): Rgb {
  const index = (y * width + x) * 4;
  return {
    r: imageData.data[index],
    g: imageData.data[index + 1],
    b: imageData.data[index + 2],
  };
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
