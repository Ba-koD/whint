import type { CellState, Grid } from "./types";
import { getCachedWords } from "./wordData";
import { createEmptyGrid, MAX_GUESSES, WORD_LENGTH } from "./wordle";

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
  source: "keyboard" | "stored" | "rendered";
  mask: Uint8Array;
  dilatedMask: Uint8Array;
  active: number[];
  rowProfile: Uint8Array;
  colProfile: Uint8Array;
}

interface TemplateMatch {
  letter: string;
  source: LetterTemplate["source"] | "";
  score: number;
  margin: number;
}

export interface RecognitionProgress {
  phase: "image" | "letters" | "done";
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
const STORED_TEMPLATE_KEY = "whint.letterTemplates.v5";
const STORED_TEMPLATE_VERSION = 5;
const MIN_VALID_KEYBOARD_TEMPLATES = 20;
const MAX_INVALID_KEYBOARD_TEMPLATES = 2;
const KEYBOARD_TEMPLATE_SELF_SCORE = 0.48;
const KEYBOARD_TEMPLATE_SELF_MARGIN = -0.02;
const TEMPLATE_FONTS = [
  'Franklin Gothic Heavy',
  'Franklin Gothic Demi',
  'Franklin Gothic Medium',
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
let storedTemplateCache: LetterTemplate[] | undefined;
let validatedStoredTemplateCache: LetterTemplate[] | undefined;

export async function recognizeBoardFromImage(
  file: Blob,
  onProgress?: (progress: RecognitionProgress) => void,
  options: RecognitionOptions = {},
): Promise<RecognizedBoard> {
  const canvas = await blobToCanvas(file);
  return recognizeBoardFromCanvas(canvas, onProgress, options);
}

export function warmRecognitionTemplates() {
  if (typeof window === "undefined") {
    return;
  }

  const buildTemplates = () => {
    try {
      const templates = getLetterTemplates();
      getValidatedStoredTemplates(templates);
    } catch {
      // Template warming is an optimization; normal recognition can still build them later.
    }
  };

  const idleWindow = window as Window & {
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };

  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(buildTemplates, { timeout: 1800 });
  } else {
    window.setTimeout(buildTemplates, 120);
  }
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
    warnings.push(error instanceof Error ? error.message : "글자 인식 중 오류가 발생했습니다.");
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
  const templates = getFrameLetterTemplates(source);

  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    const template = guessLetterByTemplate(source, box, templates);
    const shapeLetter = guessLetterByShape(source, box);
    const result = chooseRecognizedLetter(shapeLetter, template);

    grid[box.row][box.col] = {
      ...grid[box.row][box.col],
      letter: result.letter,
      confidence: result.confidence,
    };

    onProgress?.({
      phase: "letters",
      message: "글자 인식",
      progress: 0.25 + ((index + 1) / boxes.length) * 0.7,
    });
  }
}

function chooseRecognizedLetter(
  shapeLetter: string,
  template: TemplateMatch,
): { letter: string; confidence: number } {
  if (!template.letter) {
    return { letter: shapeLetter, confidence: shapeLetter ? 45 : 0 };
  }

  const templateConfidence = Math.round(clamp(template.score * 100, 0, 99));

  if (shapeLetter && shapeLetter !== template.letter) {
    if (isShapeOverride(shapeLetter, template)) {
      return { letter: shapeLetter, confidence: Math.max(58, templateConfidence - 10) };
    }

    if (!isStrongTemplateMatch(template)) {
      return { letter: shapeLetter, confidence: Math.max(50, templateConfidence) };
    }
  }

  if (isUsableTemplateMatch(template)) {
    return { letter: template.letter, confidence: templateConfidence };
  }

  if (shapeLetter) {
    return { letter: shapeLetter, confidence: Math.max(42, templateConfidence) };
  }

  return { letter: template.score >= 0.5 ? template.letter : "", confidence: templateConfidence };
}

function isUsableTemplateMatch(template: TemplateMatch): boolean {
  if (template.source === "keyboard" || template.source === "stored") {
    return template.score >= 0.5 && template.margin >= 0.006;
  }
  return template.score >= 0.56 && template.margin >= 0.012;
}

function isStrongTemplateMatch(template: TemplateMatch): boolean {
  if (template.source === "keyboard" || template.source === "stored") {
    return template.score >= 0.58 && template.margin >= 0.015;
  }
  return template.score >= 0.62 && template.margin >= 0.025;
}

function isShapeOverride(shapeLetter: string, template: TemplateMatch): boolean {
  return (
    (shapeLetter === "D" && ["O", "Q", "U"].includes(template.letter)) ||
    (shapeLetter === "O" && ["D", "T", "U"].includes(template.letter)) ||
    (shapeLetter === "U" && ["D", "O", "Y"].includes(template.letter)) ||
    (shapeLetter === "V" && ["E", "M", "W", "U"].includes(template.letter)) ||
    (shapeLetter === "I" && ["D", "O", "Q", "L", "T", "J"].includes(template.letter))
  );
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
  const sampleTemplate: LetterTemplate = {
    letter: "",
    source: "rendered",
    mask: sample.mask,
    dilatedMask: sampleDilated,
    active: sample.active,
    rowProfile: sample.rowProfile,
    colProfile: sample.colProfile,
  };

  for (const template of templates) {
    const score = scoreTemplateMatch(sampleTemplate, template);
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
  const fallbackTemplates = getLetterTemplates();
  const keyboardTemplates = validateKeyboardTemplates(
    extractKeyboardLetterTemplates(source),
    fallbackTemplates,
  );
  if (keyboardTemplates.length >= MIN_VALID_KEYBOARD_TEMPLATES) {
    saveStoredLetterTemplates(keyboardTemplates);
  }

  const templates: LetterTemplate[] = [...keyboardTemplates];
  const coveredLetters = new Set(templates.map((template) => template.letter));

  if (coveredLetters.size < LETTERS.length) {
    for (const template of getValidatedStoredTemplates(fallbackTemplates)) {
      if (!coveredLetters.has(template.letter)) {
        templates.push(template);
        coveredLetters.add(template.letter);
      }
    }
  }

  return [...templates, ...fallbackTemplates];
}

function getValidatedStoredTemplates(fallbackTemplates: LetterTemplate[]): LetterTemplate[] {
  if (validatedStoredTemplateCache !== undefined) {
    return validatedStoredTemplateCache;
  }

  validatedStoredTemplateCache = validateKeyboardTemplates(loadStoredLetterTemplates(), fallbackTemplates);
  return validatedStoredTemplateCache;
}

function validateKeyboardTemplates(
  templates: LetterTemplate[],
  fallbackTemplates: LetterTemplate[],
): LetterTemplate[] {
  if (templates.length < MIN_VALID_KEYBOARD_TEMPLATES) {
    return [];
  }

  const validated: LetterTemplate[] = [];
  let invalidCount = 0;

  for (const template of templates) {
    const match = classifyTemplateByFallback(template, fallbackTemplates);
    const isValid =
      match.letter === template.letter &&
      match.score >= KEYBOARD_TEMPLATE_SELF_SCORE &&
      match.margin >= KEYBOARD_TEMPLATE_SELF_MARGIN;

    if (isValid) {
      validated.push(template);
    } else {
      invalidCount += 1;
    }
  }

  if (
    validated.length < MIN_VALID_KEYBOARD_TEMPLATES ||
    invalidCount > MAX_INVALID_KEYBOARD_TEMPLATES
  ) {
    return [];
  }

  return validated;
}

function classifyTemplateByFallback(
  sample: LetterTemplate,
  fallbackTemplates: LetterTemplate[],
): TemplateMatch {
  const scoresByLetter = new Map<string, number>();

  for (const template of fallbackTemplates) {
    const score = scoreTemplateMatch(sample, template);
    const current = scoresByLetter.get(template.letter);
    if (current === undefined || score > current) {
      scoresByLetter.set(template.letter, score);
    }
  }

  const ranked = [...scoresByLetter.entries()].sort((a, b) => b[1] - a[1]);
  const [letter, score] = ranked[0] ?? ["", 0];
  const secondScore = ranked[1]?.[1] ?? 0;
  return {
    letter,
    source: "rendered",
    score,
    margin: score - secondScore,
  };
}

function scoreTemplateMatch(sample: LetterTemplate, template: LetterTemplate): number {
  const forward = coverage(sample.active, template.dilatedMask);
  const backward = coverage(template.active, sample.dilatedMask);
  const maskScore = (forward + backward) / 2;
  const rowScore = profileSimilarity(sample.rowProfile, template.rowProfile);
  const colScore = profileSimilarity(sample.colProfile, template.colProfile);
  const profileScore = (rowScore + colScore) / 2;
  return maskScore * 0.72 + profileScore * 0.28;
}

function profileSimilarity(first: Uint8Array, second: Uint8Array): number {
  let difference = 0;
  let scale = 0;

  for (let index = 0; index < TEMPLATE_SIZE; index += 1) {
    const firstCount = first[index];
    const secondCount = second[index];
    difference += Math.abs(firstCount - secondCount);
    scale += Math.max(firstCount, secondCount);
  }

  return scale === 0 ? 0 : 1 - difference / scale;
}

function saveStoredLetterTemplates(templates: LetterTemplate[]) {
  if (typeof localStorage === "undefined") {
    return;
  }

  const merged = new Map(loadStoredLetterTemplates().map((template) => [template.letter, template]));
  for (const template of templates) {
    merged.set(template.letter, template);
  }

  const orderedTemplates = LETTERS.split("")
    .map((letter) => merged.get(letter))
    .filter((template): template is LetterTemplate => Boolean(template));

  try {
    localStorage.setItem(
      STORED_TEMPLATE_KEY,
      JSON.stringify({
        version: STORED_TEMPLATE_VERSION,
        size: TEMPLATE_SIZE,
        templates: orderedTemplates.map((template) => ({
          letter: template.letter,
          mask: maskToString(template.mask),
        })),
      }),
    );
    storedTemplateCache = orderedTemplates.map((template) => ({
      ...template,
      source: "stored",
    }));
    validatedStoredTemplateCache = undefined;
  } catch {
    // Storage can fail in private mode or when quota is unavailable.
  }
}

function loadStoredLetterTemplates(): LetterTemplate[] {
  if (storedTemplateCache !== undefined) {
    return storedTemplateCache;
  }

  storedTemplateCache = [];
  if (typeof localStorage === "undefined") {
    return storedTemplateCache;
  }

  try {
    const raw = localStorage.getItem(STORED_TEMPLATE_KEY);
    if (!raw) {
      return storedTemplateCache;
    }

    const parsed = JSON.parse(raw) as {
      version?: number;
      size?: number;
      templates?: Array<{ letter?: string; mask?: string }>;
    };

    if (
      parsed.version !== STORED_TEMPLATE_VERSION ||
      parsed.size !== TEMPLATE_SIZE ||
      !Array.isArray(parsed.templates)
    ) {
      return storedTemplateCache;
    }

    storedTemplateCache = parsed.templates
      .map((template) => restoreStoredLetterTemplate(template.letter, template.mask))
      .filter((template): template is LetterTemplate => Boolean(template));
    return storedTemplateCache;
  } catch {
    return storedTemplateCache;
  }
}

function restoreStoredLetterTemplate(letter: unknown, encodedMask: unknown): LetterTemplate | null {
  if (
    typeof letter !== "string" ||
    !LETTERS.includes(letter) ||
    typeof encodedMask !== "string" ||
    encodedMask.length !== TEMPLATE_SIZE * TEMPLATE_SIZE ||
    /[^01]/.test(encodedMask)
  ) {
    return null;
  }

  const mask = new Uint8Array(TEMPLATE_SIZE * TEMPLATE_SIZE);
  for (let index = 0; index < encodedMask.length; index += 1) {
    mask[index] = encodedMask[index] === "1" ? 1 : 0;
  }

  return {
    letter,
    source: "stored",
    mask,
    dilatedMask: dilateMask(mask, TEMPLATE_SIZE),
    active: activeIndexes(mask),
    rowProfile: buildMaskProfile(mask, "row"),
    colProfile: buildMaskProfile(mask, "column"),
  };
}

function maskToString(mask: Uint8Array): string {
  let result = "";
  for (const value of mask) {
    result += value ? "1" : "0";
  }
  return result;
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
    isNearColor(pixel, { r: 211, g: 214, b: 218 }, 50) ||
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
  const background = sampleKeyBackground(image, key.width, key.height);
  const backgroundLuma = luminance(background);

  for (let y = insetY; y < key.height - insetY; y += 1) {
    for (let x = insetX; x < key.width - insetX; x += 1) {
      const index = (y * key.width + x) * 4;
      const r = image.data[index];
      const g = image.data[index + 1];
      const b = image.data[index + 2];
      const pixelLuma = luminance({ r, g, b });
      if (Math.abs(pixelLuma - backgroundLuma) > 52) {
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
    rowProfile: normalized.rowProfile,
    colProfile: normalized.colProfile,
  };
}

function sampleKeyBackground(image: ImageData, width: number, height: number): Rgb {
  const samples: Rgb[] = [];
  const sampleWidth = Math.max(2, Math.round(width * 0.16));
  const sampleHeight = Math.max(2, Math.round(height * 0.18));
  const regions = [
    { left: 1, top: 1 },
    { left: Math.max(1, width - sampleWidth - 1), top: 1 },
    { left: 1, top: Math.max(1, height - sampleHeight - 1) },
    { left: Math.max(1, width - sampleWidth - 1), top: Math.max(1, height - sampleHeight - 1) },
  ];

  for (const region of regions) {
    for (let y = region.top; y < Math.min(height, region.top + sampleHeight); y += 1) {
      for (let x = region.left; x < Math.min(width, region.left + sampleWidth); x += 1) {
        const index = (y * width + x) * 4;
        samples.push({
          r: image.data[index],
          g: image.data[index + 1],
          b: image.data[index + 2],
        });
      }
    }
  }

  if (samples.length === 0) {
    return { r: 0, g: 0, b: 0 };
  }

  return {
    r: samples.reduce((sum, pixel) => sum + pixel.r, 0) / samples.length,
    g: samples.reduce((sum, pixel) => sum + pixel.g, 0) / samples.length,
    b: samples.reduce((sum, pixel) => sum + pixel.b, 0) / samples.length,
  };
}

function luminance(pixel: Rgb): number {
  return pixel.r * 0.2126 + pixel.g * 0.7152 + pixel.b * 0.0722;
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
  ctx.font = `700 100px ${font.includes(" ") ? `"${font}"` : font}`;
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
    rowProfile: normalized.rowProfile,
    colProfile: normalized.colProfile,
  };
}

function pointsToMask(
  points: Array<{ x: number; y: number }>,
  size: number,
): { mask: Uint8Array; active: number[]; rowProfile: Uint8Array; colProfile: Uint8Array } {
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

  return {
    mask,
    active: activeIndexes(mask),
    rowProfile: buildMaskProfile(mask, "row"),
    colProfile: buildMaskProfile(mask, "column"),
  };
}

function buildMaskProfile(mask: Uint8Array, direction: "row" | "column"): Uint8Array {
  const profile = new Uint8Array(TEMPLATE_SIZE);

  for (let outer = 0; outer < TEMPLATE_SIZE; outer += 1) {
    let count = 0;
    for (let inner = 0; inner < TEMPLATE_SIZE; inner += 1) {
      const index =
        direction === "row" ? outer * TEMPLATE_SIZE + inner : inner * TEMPLATE_SIZE + outer;
      count += mask[index];
    }
    profile[outer] = count;
  }

  return profile;
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
  const background = sampleKeyBackground(image, size, size);
  const backgroundLuma = luminance(background);

  for (let y = margin; y < size - margin; y += 1) {
    for (let x = margin; x < size - margin; x += 1) {
      const index = (y * size + x) * 4;
      const r = image.data[index];
      const g = image.data[index + 1];
      const b = image.data[index + 2];
      if (isLetterPixel({ r, g, b }, background, backgroundLuma)) {
        points.push({ x, y });
      }
    }
  }

  return points;
}

function isLetterPixel(pixel: Rgb, background: Rgb, backgroundLuma: number): boolean {
  const pixelLuma = luminance(pixel);
  const distance = colorDistance(pixel, background);

  if (backgroundLuma > 210) {
    return pixelLuma < backgroundLuma - 45 && distance > 45;
  }

  return pixelLuma > backgroundLuma + 30 && distance > 36;
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
  const topLeft = ratioInRegion(
    points,
    minX,
    minX + width * 0.32,
    minY,
    minY + height * 0.26,
  );
  const topRight = ratioInRegion(
    points,
    maxX - width * 0.32,
    maxX,
    minY,
    minY + height * 0.26,
  );
  const bottomLeft = ratioInRegion(
    points,
    minX,
    minX + width * 0.34,
    maxY - height * 0.24,
    maxY,
  );
  const bottomRight = ratioInRegion(
    points,
    maxX - width * 0.34,
    maxX,
    maxY - height * 0.24,
    maxY,
  );
  const center = ratioInRegion(
    points,
    minX + width * 0.34,
    maxX - width * 0.34,
    minY + height * 0.34,
    maxY - height * 0.34,
  );
  const midLeft = ratioInRegion(
    points,
    minX,
    minX + width * 0.24,
    minY + height * 0.34,
    maxY - height * 0.34,
  );
  const midRight = ratioInRegion(
    points,
    maxX - width * 0.24,
    maxX,
    minY + height * 0.34,
    maxY - height * 0.34,
  );
  const topFull = ratioInRegion(points, minX, maxX, minY, minY + height * 0.22);
  const midFull = ratioInRegion(
    points,
    minX,
    maxX,
    minY + height * 0.38,
    minY + height * 0.62,
  );
  const bottomFull = ratioInRegion(points, minX, maxX, maxY - height * 0.22, maxY);
  const leftFull = ratioInRegion(points, minX, minX + width * 0.24, minY, maxY);
  const rightFull = ratioInRegion(points, maxX - width * 0.24, maxX, minY, maxY);
  const bottomRightLower = ratioInRegion(
    points,
    maxX - width * 0.38,
    maxX,
    maxY - height * 0.28,
    maxY,
  );

  if (aspect < 0.45 && height > tileSize * 0.36 && fill > 0.42) {
    return "I";
  }

  if (
    aspect >= 0.5 &&
    aspect <= 0.72 &&
    fill >= 0.52 &&
    fill <= 0.76 &&
    leftFull > 0.7 &&
    rightFull < 0.5 &&
    topFull > 0.45 &&
    midFull > 0.45 &&
    bottomFull > 0.45 &&
    bottomRightLower > 0.16
  ) {
    return "E";
  }

  if (
    aspect >= 0.62 &&
    aspect <= 1.18 &&
    fill >= 0.16 &&
    fill <= 0.52 &&
    topMiddle < 0.14 &&
    topLeft > 0.06 &&
    topRight > 0.06 &&
    bottomMiddle > 0.08 &&
    bottomLeft < 0.16 &&
    bottomRight < 0.16
  ) {
    return "V";
  }

  if (
    aspect >= 0.58 &&
    aspect <= 1.08 &&
    fill >= 0.48 &&
    fill <= 0.82 &&
    center < 0.12 &&
    topMiddle > 0.18 &&
    topLeft > 0.68 &&
    bottomLeft > 0.64 &&
    topRight > 0.24 &&
    bottomRight > 0.22
  ) {
    return "D";
  }

  if (
    aspect >= 0.56 &&
    aspect <= 1.05 &&
    fill >= 0.2 &&
    fill <= 0.76 &&
    topMiddle < 0.08 &&
    bottomMiddle > 0.16 &&
    bottomLeft > 0.18 &&
    bottomRight > 0.18 &&
    leftLower > 0.16 &&
    rightLower > 0.16
  ) {
    return "U";
  }

  if (
    aspect >= 0.68 &&
    aspect <= 1.22 &&
    fill >= 0.22 &&
    fill <= 0.7 &&
    topMiddle > 0.18 &&
    bottomMiddle > 0.18 &&
    midLeft > 0.3 &&
    midRight > 0.3
  ) {
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
