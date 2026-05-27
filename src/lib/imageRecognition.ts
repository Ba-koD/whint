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

interface TileComponent {
  centerX: number;
  centerY: number;
  size: number;
  fillRatio: number;
}

interface KeyboardKeyComponent {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
}

interface RowCandidate {
  xCenters: number[];
  centerY: number;
  tileSize: number;
  xPitch: number;
  score: number;
}

interface GridCandidate {
  boxes: TileBox[];
  score: number;
}

interface LetterTemplate {
  letter: string;
  source: "keyboard" | "rendered";
  mask: Uint8Array;
  dilatedMask: Uint8Array;
  active: number[];
}

interface TemplateMatch {
  letter: string;
  source: "keyboard" | "rendered" | "";
  score: number;
  margin: number;
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

export interface RecognitionOptions {
  recognizeLetters?: boolean;
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
const BORDER_COLOR_THRESHOLD = 42;

const TILE_BORDER_REFS: Rgb[] = [
  { r: 58, g: 58, b: 60 },
  { r: 66, g: 72, b: 83 },
  { r: 86, g: 87, b: 88 },
  { r: 135, g: 138, b: 140 },
  { r: 211, g: 214, b: 218 },
];

const TEMPLATE_SIZE = 32;
const TEMPLATE_FONTS = [
  'Arial Black',
  'Helvetica Neue',
  'Arial',
  'Inter',
  'system-ui',
  'sans-serif',
];
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const KEYBOARD_ROWS = [
  { letters: "QWERTYUIOP", minKeys: 10 },
  { letters: "ASDFGHJKL", minKeys: 9 },
  { letters: "ZXCVBNM", minKeys: 7 },
];
let letterTemplateCache: LetterTemplate[] | null = null;

export async function recognizeBoardFromImage(
  file: Blob,
  onProgress?: (progress: RecognitionProgress) => void,
  options: RecognitionOptions = {},
): Promise<RecognizedBoard> {
  const canvas = await blobToCanvas(file);
  return recognizeBoardFromCanvas(canvas, onProgress, options);
}

export async function recognizeBoardFromCanvas(
  canvas: HTMLCanvasElement,
  onProgress?: (progress: RecognitionProgress) => void,
  options: RecognitionOptions = {},
): Promise<RecognizedBoard> {
  onProgress?.({ phase: "image", message: "그리드 탐지", progress: 0.05 });

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

  if (options.recognizeLetters === false) {
    onProgress?.({ phase: "done", message: "그리드 확인", progress: 1 });
    return { grid, warnings };
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
  const componentBoxes = detectGridBoxesFromComponents(imageData, canvas.width, canvas.height);
  if (componentBoxes) {
    return componentBoxes;
  }

  return detectGridBoxesFromProjection(imageData, canvas.width, canvas.height);
}

function detectGridBoxesFromComponents(
  imageData: ImageData,
  imageWidth: number,
  imageHeight: number,
): TileBox[] | null {
  const components = findTileComponents(imageData, imageWidth, imageHeight);
  if (components.length < WORD_LENGTH) {
    return null;
  }

  const rowCandidates = findRowCandidates(components);
  if (rowCandidates.length === 0) {
    return null;
  }

  const gridCandidates = rowCandidates
    .map((row) => buildGridCandidate(row, rowCandidates, imageWidth, imageHeight))
    .filter((candidate): candidate is GridCandidate => candidate !== null);

  if (gridCandidates.length === 0) {
    return null;
  }

  return gridCandidates.sort((a, b) => b.score - a.score)[0].boxes;
}

function findTileComponents(
  imageData: ImageData,
  imageWidth: number,
  imageHeight: number,
): TileComponent[] {
  const mask = new Uint8Array(imageWidth * imageHeight);
  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const index = y * imageWidth + x;
      if (isTileStructurePixel(getPixel(imageData, imageWidth, x, y))) {
        mask[index] = 1;
      }
    }
  }

  const components: TileComponent[] = [];
  const minTileSize = Math.max(16, Math.min(imageWidth, imageHeight) * 0.014);
  const maxTileSize = Math.min(imageWidth, imageHeight) * 0.42;
  const stack: number[] = [];

  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) {
      continue;
    }

    mask[index] = 0;
    stack.push(index);

    let count = 0;
    let minX = imageWidth;
    let minY = imageHeight;
    let maxX = 0;
    let maxY = 0;

    while (stack.length > 0) {
      const current = stack.pop() ?? 0;
      const x = current % imageWidth;
      const y = Math.floor(current / imageWidth);

      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const left = current - 1;
      if (x > 0 && mask[left] === 1) {
        mask[left] = 0;
        stack.push(left);
      }

      const right = current + 1;
      if (x < imageWidth - 1 && mask[right] === 1) {
        mask[right] = 0;
        stack.push(right);
      }

      const up = current - imageWidth;
      if (y > 0 && mask[up] === 1) {
        mask[up] = 0;
        stack.push(up);
      }

      const down = current + imageWidth;
      if (y < imageHeight - 1 && mask[down] === 1) {
        mask[down] = 0;
        stack.push(down);
      }
    }

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const size = (width + height) / 2;
    const aspect = width / height;
    const fillRatio = count / (width * height);

    if (
      width < minTileSize ||
      height < minTileSize ||
      size > maxTileSize ||
      aspect < 0.68 ||
      aspect > 1.38 ||
      fillRatio < 0.035
    ) {
      continue;
    }

    components.push({
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
      size,
      fillRatio,
    });
  }

  return components;
}

function isTileStructurePixel(pixel: Rgb): boolean {
  return isFilledTilePixel(pixel) || isTileBorderPixel(pixel);
}

function isTileBorderPixel(pixel: Rgb): boolean {
  const max = Math.max(pixel.r, pixel.g, pixel.b);
  const min = Math.min(pixel.r, pixel.g, pixel.b);
  if (max - min > 22 || max < 34 || max > 226) {
    return false;
  }

  return TILE_BORDER_REFS.some((ref) => colorDistance(pixel, ref) <= BORDER_COLOR_THRESHOLD);
}

function findRowCandidates(components: TileComponent[]): RowCandidate[] {
  const rowClusters: TileComponent[][] = [];
  const sortedByY = [...components].sort((a, b) => a.centerY - b.centerY);

  for (const component of sortedByY) {
    const current = rowClusters[rowClusters.length - 1];
    if (!current) {
      rowClusters.push([component]);
      continue;
    }

    const centerY = median(current.map((item) => item.centerY));
    const tileSize = median(current.map((item) => item.size));
    const tolerance = Math.max(8, tileSize * 0.42);
    if (Math.abs(component.centerY - centerY) <= tolerance) {
      current.push(component);
    } else {
      rowClusters.push([component]);
    }
  }

  const rowCandidates: RowCandidate[] = [];
  for (const cluster of rowClusters) {
    if (cluster.length < WORD_LENGTH) {
      continue;
    }

    const sortedByX = [...cluster].sort((a, b) => a.centerX - b.centerX);
    for (let index = 0; index <= sortedByX.length - WORD_LENGTH; index += 1) {
      const candidate = createRowCandidate(
        sortedByX.slice(index, index + WORD_LENGTH),
        sortedByX,
      );
      if (candidate) {
        rowCandidates.push(candidate);
      }
    }
  }

  return rowCandidates;
}

function createRowCandidate(
  tiles: TileComponent[],
  rowTiles: TileComponent[],
): RowCandidate | null {
  const tileSize = median(tiles.map((tile) => tile.size));
  const xCenters = tiles.map((tile) => tile.centerX);
  const gaps = xCenters.slice(1).map((center, index) => center - xCenters[index]);
  const xPitch = median(gaps);
  const yCenters = tiles.map((tile) => tile.centerY);
  const ySpread = Math.max(...yCenters) - Math.min(...yCenters);
  const fillRatio = median(tiles.map((tile) => tile.fillRatio));
  const extraAlignedTiles = countExtraAlignedTiles(rowTiles, tiles, tileSize, xPitch);

  if (
    tiles.some((tile) => Math.abs(tile.size - tileSize) > tileSize * 0.28) ||
    ySpread > Math.max(8, tileSize * 0.2) ||
    xPitch < tileSize * 0.84 ||
    xPitch > tileSize * 1.45 ||
    gaps.some((gap) => Math.abs(gap - xPitch) > Math.max(6, xPitch * 0.2)) ||
    extraAlignedTiles >= 1
  ) {
    return null;
  }

  return {
    xCenters,
    centerY: median(yCenters),
    tileSize,
    xPitch,
    score: tileSize + fillRatio * 80 - ySpread - extraAlignedTiles * 120,
  };
}

function countExtraAlignedTiles(
  rowTiles: TileComponent[],
  selectedTiles: TileComponent[],
  tileSize: number,
  xPitch: number,
): number {
  const selected = new Set(selectedTiles);
  const selectedCenters = selectedTiles.map((tile) => tile.centerX);
  const leftLimit = Math.min(...selectedCenters) - xPitch * 1.35;
  const rightLimit = Math.max(...selectedCenters) + xPitch * 1.35;

  return rowTiles.filter((tile) => {
    if (selected.has(tile)) {
      return false;
    }
    if (tile.centerX < leftLimit || tile.centerX > rightLimit) {
      return false;
    }
    return Math.abs(tile.size - tileSize) <= tileSize * 0.3;
  }).length;
}

function buildGridCandidate(
  seed: RowCandidate,
  rows: RowCandidate[],
  imageWidth: number,
  imageHeight: number,
): GridCandidate | null {
  const compatibleRows = rows
    .filter((row) => rowsAreCompatible(seed, row))
    .sort((a, b) => a.centerY - b.centerY);

  if (compatibleRows.length === 0) {
    return null;
  }

  const topRowCenter = compatibleRows[0].centerY;
  let rowPitch = median(compatibleRows.map((row) => row.xPitch));
  const positionedRows = new Map<number, RowCandidate>();

  for (const row of compatibleRows) {
    const position = Math.round((row.centerY - topRowCenter) / rowPitch);
    const expectedCenter = topRowCenter + position * rowPitch;
    const tolerance = Math.max(8, seed.tileSize * 0.28);
    if (
      position < 0 ||
      position >= MAX_GUESSES ||
      Math.abs(row.centerY - expectedCenter) > tolerance
    ) {
      continue;
    }

    const existing = positionedRows.get(position);
    if (!existing || row.score > existing.score) {
      positionedRows.set(position, row);
    }
  }

  const matchedRows = [...positionedRows.entries()].sort((a, b) => a[0] - b[0]);
  if (matchedRows.length < 2 || matchedRows[0][0] !== 0) {
    return null;
  }

  if (matchedRows.length >= 2) {
    const pitches = matchedRows.slice(1).map(([position, row], index) => {
      const [previousPosition, previousRow] = matchedRows[index];
      return (row.centerY - previousRow.centerY) / (position - previousPosition);
    });
    rowPitch = median(pitches);
  }

  const rowValues = matchedRows.map(([, row]) => row);
  const tileSize = median(rowValues.map((row) => row.tileSize));
  const xCenters = Array.from({ length: WORD_LENGTH }, (_, col) =>
    median(rowValues.map((row) => row.xCenters[col])),
  );
  const topCenterY = matchedRows[0][1].centerY;
  const boardLeft = xCenters[0] - tileSize / 2;
  const boardRight = xCenters[WORD_LENGTH - 1] + tileSize / 2;
  const boardTop = topCenterY - tileSize / 2;
  const boardBottom = topCenterY + rowPitch * (MAX_GUESSES - 1) + tileSize / 2;
  const margin = Math.max(8, tileSize * 0.55);

  if (
    boardLeft < -margin ||
    boardRight > imageWidth + margin ||
    boardTop < -margin ||
    boardBottom > imageHeight + margin
  ) {
    return null;
  }

  const boxes: TileBox[] = [];
  for (let row = 0; row < MAX_GUESSES; row += 1) {
    const centerY = topCenterY + rowPitch * row;
    for (let col = 0; col < WORD_LENGTH; col += 1) {
      boxes.push({
        row,
        col,
        left: Math.round(xCenters[col] - tileSize / 2),
        top: Math.round(centerY - tileSize / 2),
        size: Math.round(tileSize),
      });
    }
  }

  const averageRowScore = rowValues.reduce((sum, row) => sum + row.score, 0) / rowValues.length;
  const score = matchedRows.length * 1000 + averageRowScore + Math.min(tileSize, 140);
  return { boxes, score };
}

function rowsAreCompatible(seed: RowCandidate, row: RowCandidate): boolean {
  const sizeTolerance = seed.tileSize * 0.26;
  const pitchTolerance = seed.xPitch * 0.2;
  const centerTolerance = Math.max(8, seed.tileSize * 0.22);

  return (
    Math.abs(row.tileSize - seed.tileSize) <= sizeTolerance &&
    Math.abs(row.xPitch - seed.xPitch) <= pitchTolerance &&
    row.xCenters.every((center, index) => Math.abs(center - seed.xCenters[index]) <= centerTolerance)
  );
}

function detectGridBoxesFromProjection(
  imageData: ImageData,
  imageWidth: number,
  imageHeight: number,
): TileBox[] {
  const xCounts = Array.from({ length: imageWidth }, () => 0);
  const yCounts = Array.from({ length: imageHeight }, () => 0);

  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const pixel = getPixel(imageData, imageWidth, x, y);
      if (isFilledTilePixel(pixel)) {
        xCounts[x] += 1;
        yCounts[y] += 1;
      }
    }
  }

  const xSpans = topSpans(
    spansFromProjection(xCounts, Math.max(10, imageHeight * 0.045), 18),
    WORD_LENGTH,
  ).sort((a, b) => a.start - b.start);
  const ySpans = topSpans(
    spansFromProjection(yCounts, Math.max(10, imageWidth * 0.1), 18),
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
    const templates = getFrameLetterTemplates(source);
    await worker.setParameters({
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_CHAR,
      user_defined_dpi: "160",
    });

    for (let index = 0; index < boxes.length; index += 1) {
      const box = boxes[index];
      const result = await recognizeCellLetter(worker, source, box, Tesseract.PSM);
      const template = guessLetterByTemplate(source, box, templates);
      const shapeLetter = guessLetterByShape(source, box);
      const letter = chooseRecognizedLetter(result, shapeLetter, template);

      grid[box.row][box.col] = {
        ...grid[box.row][box.col],
        letter,
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

function chooseRecognizedLetter(
  result: { letter: string; confidence: number },
  shapeLetter: string,
  template: TemplateMatch,
): string {
  if (!result.letter) {
    return template.score >= 0.52 ? template.letter : shapeLetter;
  }

  if (isVeryStrongTemplateMatch(template) && result.letter !== template.letter) {
    return template.letter;
  }

  if (
    template.source === "keyboard" &&
    isStrongTemplateMatch(template) &&
    result.letter !== template.letter
  ) {
    return template.letter;
  }

  if (isStrongTemplateMatch(template) && result.letter !== template.letter) {
    if (isKnownTemplateConfusion(template.letter, result.letter) || result.confidence < 88) {
      return template.letter;
    }
  }

  if (!shapeLetter || result.letter === shapeLetter) {
    return result.letter;
  }

  if (shapeLetter === "O" && result.letter === "T") {
    return shapeLetter;
  }

  if (shapeLetter === "U" && ["D", "V"].includes(result.letter)) {
    return shapeLetter;
  }

  if (shapeLetter === "O" && ["D", "Q", "U"].includes(result.letter)) {
    return result.confidence <= 82 ? shapeLetter : result.letter;
  }

  if (shapeLetter === "I" && ["L", "T", "J"].includes(result.letter)) {
    return result.confidence <= 76 ? shapeLetter : result.letter;
  }

  return result.confidence < 55 ? shapeLetter : result.letter;
}

function isVeryStrongTemplateMatch(template: TemplateMatch): boolean {
  if (template.source === "keyboard") {
    return template.score >= 0.66 && template.margin >= 0.025;
  }
  return template.score >= 0.72 && template.margin >= 0.055;
}

function isStrongTemplateMatch(template: TemplateMatch): boolean {
  if (template.source === "keyboard") {
    return template.score >= 0.58 && template.margin >= 0.015;
  }
  return template.score >= 0.62 && template.margin >= 0.025;
}

function isKnownTemplateConfusion(templateLetter: string, ocrLetter: string): boolean {
  return (
    (templateLetter === "U" && ["D", "V"].includes(ocrLetter)) ||
    (templateLetter === "D" && ["O", "U"].includes(ocrLetter)) ||
    (templateLetter === "O" && ["D", "Q", "T", "U"].includes(ocrLetter)) ||
    (templateLetter === "I" && ["L", "T", "J"].includes(ocrLetter)) ||
    (templateLetter === "S" && ["R", "Z"].includes(ocrLetter)) ||
    (templateLetter === "R" && ["S", "P"].includes(ocrLetter))
  );
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

function guessLetterByTemplate(
  source: HTMLCanvasElement,
  box: TileBox,
  templates: LetterTemplate[],
): TemplateMatch {
  const points = getLetterPoints(source, box);
  if (points.length < box.size * 1.45) {
    return { letter: "", source: "", score: 0, margin: 0 };
  }

  const sample = pointsToMask(points, TEMPLATE_SIZE);
  const sampleDilated = dilateMask(sample.mask, TEMPLATE_SIZE);
  const scoresByLetter = new Map<string, { score: number; source: LetterTemplate["source"] }>();

  for (const template of templates) {
    const forward = coverage(sample.active, template.dilatedMask);
    const backward = coverage(template.active, sampleDilated);
    const score = (forward + backward) / 2;
    const current = scoresByLetter.get(template.letter);
    if (!current || score > current.score) {
      scoresByLetter.set(template.letter, { score, source: template.source });
    }
  }

  const ranked = [...scoresByLetter.entries()].sort((a, b) => b[1].score - a[1].score);
  const [bestLetter, best] = ranked[0] ?? ["", { score: 0, source: "" as const }];
  const secondScore = ranked[1]?.[1].score ?? 0;
  return {
    letter: bestLetter,
    source: best.source,
    score: best.score,
    margin: best.score - secondScore,
  };
}

function getFrameLetterTemplates(source: HTMLCanvasElement): LetterTemplate[] {
  const keyboardTemplates = extractKeyboardLetterTemplates(source);
  const fallbackTemplates = getLetterTemplates();
  if (keyboardTemplates.length === 0) {
    return fallbackTemplates;
  }

  const keyboardLetters = new Set(keyboardTemplates.map((template) => template.letter));
  const missingFallbacks = fallbackTemplates.filter((template) => !keyboardLetters.has(template.letter));
  return [...keyboardTemplates, ...missingFallbacks];
}

function extractKeyboardLetterTemplates(source: HTMLCanvasElement): LetterTemplate[] {
  const imageData = getCanvasImageData(source);
  const keys = findKeyboardKeyComponents(imageData, source.width, source.height);
  if (keys.length < 20) {
    return [];
  }

  const rows = clusterKeyboardRows(keys).filter((row) => row.length >= 7);
  if (rows.length < 3) {
    return [];
  }

  const bottomRows = rows.slice(-3);
  const templates: LetterTemplate[] = [];
  for (let rowIndex = 0; rowIndex < KEYBOARD_ROWS.length; rowIndex += 1) {
    const row = [...bottomRows[rowIndex]].sort((a, b) => a.centerX - b.centerX);
    const { letters, minKeys } = KEYBOARD_ROWS[rowIndex];
    if (row.length < minKeys) {
      continue;
    }

    const letterKeys =
      rowIndex === 2 && row.length > letters.length
        ? row.slice(1, 1 + letters.length)
        : row.slice(0, letters.length);

    for (let index = 0; index < letters.length && index < letterKeys.length; index += 1) {
      const template = createKeyboardLetterTemplate(source, letterKeys[index], letters[index]);
      if (template) {
        templates.push(template);
      }
    }
  }

  return templates;
}

function findKeyboardKeyComponents(
  imageData: ImageData,
  imageWidth: number,
  imageHeight: number,
): KeyboardKeyComponent[] {
  const mask = new Uint8Array(imageWidth * imageHeight);
  const scanTop = Math.floor(imageHeight * 0.35);
  for (let y = scanTop; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const index = y * imageWidth + x;
      if (isKeyboardKeyPixel(getPixel(imageData, imageWidth, x, y))) {
        mask[index] = 1;
      }
    }
  }

  const components: KeyboardKeyComponent[] = [];
  const minHeight = Math.max(18, imageHeight * 0.018);
  const maxHeight = imageHeight * 0.12;
  const stack: number[] = [];

  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index] === 0) {
      continue;
    }

    mask[index] = 0;
    stack.push(index);

    let count = 0;
    let minX = imageWidth;
    let minY = imageHeight;
    let maxX = 0;
    let maxY = 0;

    while (stack.length > 0) {
      const current = stack.pop() ?? 0;
      const x = current % imageWidth;
      const y = Math.floor(current / imageWidth);

      count += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);

      const neighbors = [current - 1, current + 1, current - imageWidth, current + imageWidth];
      for (const neighbor of neighbors) {
        if (
          neighbor >= 0 &&
          neighbor < mask.length &&
          Math.abs((neighbor % imageWidth) - x) <= 1 &&
          mask[neighbor] === 1
        ) {
          mask[neighbor] = 0;
          stack.push(neighbor);
        }
      }
    }

    const width = maxX - minX + 1;
    const height = maxY - minY + 1;
    const aspect = width / height;
    const fillRatio = count / (width * height);

    if (
      height < minHeight ||
      height > maxHeight ||
      aspect < 0.45 ||
      aspect > 3.2 ||
      fillRatio < 0.34
    ) {
      continue;
    }

    components.push({
      left: minX,
      top: minY,
      right: maxX,
      bottom: maxY,
      width,
      height,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
    });
  }

  return components;
}

function isKeyboardKeyPixel(pixel: Rgb): boolean {
  return (
    isFilledTilePixel(pixel) ||
    isNearColor(pixel, { r: 129, g: 131, b: 132 }, 52) ||
    isNearColor(pixel, { r: 86, g: 87, b: 88 }, 48) ||
    isNearColor(pixel, { r: 58, g: 58, b: 60 }, 42)
  );
}

function isNearColor(pixel: Rgb, ref: Rgb, threshold: number): boolean {
  return colorDistance(pixel, ref) <= threshold;
}

function clusterKeyboardRows(keys: KeyboardKeyComponent[]): KeyboardKeyComponent[][] {
  const rows: KeyboardKeyComponent[][] = [];
  const sorted = [...keys].sort((a, b) => a.centerY - b.centerY);

  for (const key of sorted) {
    const current = rows[rows.length - 1];
    if (!current) {
      rows.push([key]);
      continue;
    }

    const centerY = median(current.map((item) => item.centerY));
    const height = median(current.map((item) => item.height));
    if (Math.abs(key.centerY - centerY) <= Math.max(8, height * 0.42)) {
      current.push(key);
    } else {
      rows.push([key]);
    }
  }

  return rows;
}

function createKeyboardLetterTemplate(
  source: HTMLCanvasElement,
  key: KeyboardKeyComponent,
  letter: string,
): LetterTemplate | null {
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return null;
  }

  const image = ctx.getImageData(key.left, key.top, key.width, key.height);
  const points: Array<{ x: number; y: number }> = [];
  const insetX = Math.round(key.width * 0.12);
  const insetY = Math.round(key.height * 0.12);

  for (let y = insetY; y < key.height - insetY; y += 1) {
    for (let x = insetX; x < key.width - insetX; x += 1) {
      const index = (y * key.width + x) * 4;
      const r = image.data[index];
      const g = image.data[index + 1];
      const b = image.data[index + 2];
      if (r > 185 && g > 185 && b > 185) {
        points.push({ x, y });
      }
    }
  }

  if (points.length < key.height * 0.25) {
    return null;
  }

  const normalized = pointsToMask(points, TEMPLATE_SIZE);
  return {
    letter,
    source: "keyboard",
    mask: normalized.mask,
    dilatedMask: dilateMask(normalized.mask, TEMPLATE_SIZE),
    active: normalized.active,
  };
}

function getLetterTemplates(): LetterTemplate[] {
  if (letterTemplateCache) {
    return letterTemplateCache;
  }

  letterTemplateCache = [];
  for (const font of TEMPLATE_FONTS) {
    for (const letter of LETTERS) {
      const template = renderLetterTemplate(letter, font);
      if (template) {
        letterTemplateCache.push(template);
      }
    }
  }
  return letterTemplateCache;
}

function renderLetterTemplate(letter: string, font: string): LetterTemplate | null {
  const canvas = document.createElement("canvas");
  const size = 128;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return null;
  }

  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 92px ${font.includes(" ") ? `"${font}"` : font}`;
  ctx.fillText(letter, size / 2, size / 2 + 5);

  const image = ctx.getImageData(0, 0, size, size);
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      if (image.data[index] > 96) {
        points.push({ x, y });
      }
    }
  }

  if (points.length === 0) {
    return null;
  }

  const normalized = pointsToMask(points, TEMPLATE_SIZE);
  return {
    letter,
    source: "rendered",
    mask: normalized.mask,
    dilatedMask: dilateMask(normalized.mask, TEMPLATE_SIZE),
    active: normalized.active,
  };
}

function pointsToMask(
  points: Array<{ x: number; y: number }>,
  size: number,
): { mask: Uint8Array; active: number[] } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const mask = new Uint8Array(size * size);

  for (const point of points) {
    const x = clamp(Math.round(((point.x - minX) / width) * (size - 1)), 0, size - 1);
    const y = clamp(Math.round(((point.y - minY) / height) * (size - 1)), 0, size - 1);
    mask[y * size + x] = 1;
  }

  return { mask, active: activeIndexes(mask) };
}

function activeIndexes(mask: Uint8Array): number[] {
  const active: number[] = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) {
      active.push(index);
    }
  }
  return active;
}

function dilateMask(mask: Uint8Array, size: number): Uint8Array {
  const dilated = new Uint8Array(mask.length);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!mask[y * size + x]) {
        continue;
      }
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX >= 0 && nextX < size && nextY >= 0 && nextY < size) {
            dilated[nextY * size + nextX] = 1;
          }
        }
      }
    }
  }
  return dilated;
}

function coverage(active: number[], targetMask: Uint8Array): number {
  if (active.length === 0) {
    return 0;
  }

  let hits = 0;
  for (const index of active) {
    if (targetMask[index]) {
      hits += 1;
    }
  }
  return hits / active.length;
}

function guessLetterByShape(source: HTMLCanvasElement, box: TileBox): string {
  const points = getLetterPoints(source, box);
  return classifyLetterShape(points, box.size);
}

function getLetterPoints(source: HTMLCanvasElement, box: TileBox): Array<{ x: number; y: number }> {
  const ctx = source.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    return [];
  }

  const left = clamp(box.left, 0, source.width - 1);
  const top = clamp(box.top, 0, source.height - 1);
  const size = Math.max(1, Math.min(box.size, source.width - left, source.height - top));
  const image = ctx.getImageData(left, top, size, size);
  const points: Array<{ x: number; y: number }> = [];
  const margin = Math.round(size * 0.08);

  for (let y = margin; y < size - margin; y += 1) {
    for (let x = margin; x < size - margin; x += 1) {
      const index = (y * size + x) * 4;
      const r = image.data[index];
      const g = image.data[index + 1];
      const b = image.data[index + 2];
      if (r > 175 && g > 175 && b > 175) {
        points.push({ x, y });
      }
    }
  }

  return points;
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
  const topMiddle = ratioInRegion(
    points,
    minX + width * 0.34,
    maxX - width * 0.34,
    minY,
    minY + height * 0.22,
  );
  const bottomMiddle = ratioInRegion(
    points,
    minX + width * 0.28,
    maxX - width * 0.28,
    maxY - height * 0.24,
    maxY,
  );
  const leftLower = ratioInRegion(
    points,
    minX,
    minX + width * 0.28,
    minY + height * 0.28,
    maxY - height * 0.16,
  );
  const rightLower = ratioInRegion(
    points,
    maxX - width * 0.28,
    maxX,
    minY + height * 0.28,
    maxY - height * 0.16,
  );

  if (aspect < 0.45 && height > tileSize * 0.36 && fill > 0.42) {
    return "I";
  }

  if (
    aspect >= 0.56 &&
    aspect <= 1.05 &&
    fill >= 0.2 &&
    fill <= 0.62 &&
    topMiddle < 0.08 &&
    bottomMiddle > 0.16 &&
    leftLower > 0.16 &&
    rightLower > 0.16
  ) {
    return "U";
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
