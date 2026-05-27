import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BoardGrid, type BoardTool } from "./components/BoardGrid";
import { ImageImport } from "./components/ImageImport";
import { ResultsPanel } from "./components/ResultsPanel";
import {
  recognizeBoardFromCanvas,
  recognizeBoardFromImage,
  type RecognitionProgress,
  warmRecognitionTemplates,
} from "./lib/imageRecognition";
import type { CellState, Grid, WordSource } from "./lib/types";
import {
  createEmptyGrid,
  filterCandidates,
  getCompletedGuesses,
  getRecommendations,
  normalizeLetter,
  WORD_LENGTH,
} from "./lib/wordle";
import { loadWordData } from "./lib/wordData";

const STORAGE_KEY = "whint.state.v1";
const LIVE_CAPTURE_INTERVAL_MS = 1600;
const LIVE_CAPTURE_MAX_EDGE = 1800;
const LIVE_LETTER_RETRY_INTERVAL_MS = 8000;
const LIVE_LETTER_REFRESH_INTERVAL_MS = 12000;
const LIVE_STABLE_FRAME_DELAY_MS = 450;
const LIVE_REQUIRED_STABLE_FRAMES = 2;

interface SavedState {
  grid: Grid;
  activeTool: BoardTool;
}

export default function App() {
  const savedState = useMemo(() => loadSavedState(), []);
  const [grid, setGrid] = useState<Grid>(() => savedState?.grid ?? createEmptyGrid());
  const [words, setWords] = useState<string[]>([]);
  const [source, setSource] = useState<WordSource | null>(null);
  const [loadError, setLoadError] = useState("");
  const [isRecognizing, setIsRecognizing] = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [liveRecognitionRequestId, setLiveRecognitionRequestId] = useState(0);
  const [progress, setProgress] = useState<RecognitionProgress | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [activeTool, setActiveTool] = useState<BoardTool>(savedState?.activeTool ?? "letter");
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const liveRecognizedSignatureRef = useRef("");
  const liveRecognizedAtRef = useRef(0);
  const liveLetterAttemptRef = useRef<{ signature: string; time: number } | null>(null);
  const livePendingSignatureRef = useRef({ signature: "", count: 0 });
  const forceNextLiveRecognitionRef = useRef(false);
  const liveRunGenerationRef = useRef(0);

  useEffect(() => {
    warmRecognitionTemplates();

    loadWordData()
      .then((data) => {
        setWords(data.words);
        setSource(data.source);
      })
      .catch((error) => {
        setLoadError(error instanceof Error ? error.message : "단어 목록 오류");
      });
  }, []);

  useEffect(() => {
    saveState({ activeTool, grid });
  }, [activeTool, grid]);

  const completedRows = useMemo(() => getCompletedGuesses(grid).length, [grid]);
  const candidates = useMemo(() => filterCandidates(words, grid), [words, grid]);
  const recommendations = useMemo(() => getRecommendations(words, grid, 24), [words, grid]);
  const validWords = useMemo(() => new Set(words), [words]);

  const updateCell = useCallback(
    (row: number, col: number, updater: (state: Grid[number][number]) => Grid[number][number]) => {
      setGrid((current) =>
        current.map((rowCells, rowIndex) =>
          rowCells.map((cell, colIndex) =>
            rowIndex === row && colIndex === col ? updater(cell) : cell,
          ),
        ),
      );
    },
    [],
  );

  const focusCell = useCallback((row: number, col: number) => {
    const target = document.querySelector<HTMLInputElement>(`[data-cell="${row}-${col}"]`);
    target?.focus();
    target?.select();
  }, []);

  const handleLetterChange = useCallback(
    (row: number, col: number, value: string) => {
      const letter = normalizeLetter(value);
      updateCell(row, col, (cell) => ({
        ...cell,
        letter,
        state: letter ? cell.state : "blank",
        confidence: undefined,
      }));

      if (letter) {
        const nextCol = col + 1;
        const nextRow = nextCol >= WORD_LENGTH ? row + 1 : row;
        focusCell(nextRow, nextCol >= WORD_LENGTH ? 0 : nextCol);
      }
    },
    [focusCell, updateCell],
  );

  const handleApplyState = useCallback(
    (row: number, col: number, state: CellState) => {
      updateCell(row, col, (cell) => ({
        ...cell,
        letter: state === "blank" ? "" : cell.letter,
        state,
        confidence: undefined,
      }));
    },
    [updateCell],
  );

  const handleKeyMove = useCallback(
    (row: number, col: number, event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Backspace" && !grid[row][col].letter) {
        const previousCol = col === 0 ? WORD_LENGTH - 1 : col - 1;
        const previousRow = col === 0 ? row - 1 : row;
        focusCell(previousRow, previousCol);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusCell(row, col - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        focusCell(row, col + 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusCell(row - 1, col);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        focusCell(row + 1, col);
      }
    },
    [focusCell, grid],
  );

  const handleImageFile = useCallback(async (file: File) => {
    setIsRecognizing(true);
    setProgress(null);
    setWarnings([]);
    try {
      const result = await recognizeBoardFromImage(file, setProgress);
      setGrid(result.grid);
      setWarnings(result.warnings);
    } catch (error) {
      setWarnings([error instanceof Error ? error.message : "이미지 인식 실패"]);
    } finally {
      setIsRecognizing(false);
    }
  }, []);

  const stopScreenShare = useCallback(() => {
    liveRunGenerationRef.current += 1;
    const stream = screenStreamRef.current;
    screenStreamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());

    const video = screenVideoRef.current;
    if (video) {
      video.pause();
      video.srcObject = null;
      video.remove();
      screenVideoRef.current = null;
    }

    liveRecognizedSignatureRef.current = "";
    liveRecognizedAtRef.current = 0;
    liveLetterAttemptRef.current = null;
    livePendingSignatureRef.current = { signature: "", count: 0 };
    forceNextLiveRecognitionRef.current = false;
    setIsScreenSharing(false);
    setIsRecognizing(false);
    setProgress(null);
  }, []);

  const startScreenShare = useCallback(async () => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setWarnings(["이 브라우저에서는 화면 공유를 사용할 수 없습니다."]);
      return;
    }

    stopScreenShare();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        audio: false,
        video: {
          frameRate: { ideal: 2, max: 5 },
        },
      });
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;

      screenStreamRef.current = stream;
      screenVideoRef.current = video;
      liveRunGenerationRef.current += 1;
      liveRecognizedSignatureRef.current = "";
      liveRecognizedAtRef.current = 0;
      liveLetterAttemptRef.current = null;
      livePendingSignatureRef.current = { signature: "", count: 0 };
      forceNextLiveRecognitionRef.current = false;
      stream.getVideoTracks().forEach((track) => {
        track.addEventListener("ended", stopScreenShare, { once: true });
      });

      setWarnings([]);
      setProgress({ phase: "image", message: "화면 공유 대기", progress: 0 });
      await video.play();
      setIsScreenSharing(true);
    } catch (error) {
      stopScreenShare();
      const message =
        error instanceof DOMException && error.name === "NotAllowedError"
          ? "화면 공유 권한이 취소되었습니다."
          : error instanceof Error
            ? error.message
            : "화면 공유를 시작하지 못했습니다.";
      setWarnings([message]);
    }
  }, [stopScreenShare]);

  const forceScreenRecognition = useCallback(() => {
    if (!isScreenSharing) {
      return;
    }

    liveRecognizedSignatureRef.current = "";
    liveRecognizedAtRef.current = 0;
    liveLetterAttemptRef.current = null;
    livePendingSignatureRef.current = { signature: "", count: 0 };
    forceNextLiveRecognitionRef.current = true;
    liveRunGenerationRef.current += 1;
    setGrid(createEmptyGrid());
    setWarnings([]);
    setProgress({ phase: "image", message: "재인식 대기", progress: 0 });
    setLiveRecognitionRequestId((requestId) => requestId + 1);
  }, [isScreenSharing]);

  useEffect(() => {
    if (!isScreenSharing) {
      return;
    }

    let cancelled = false;
    let timeoutId: number | null = null;
    const runGeneration = liveRunGenerationRef.current;
    const isCurrentRun = () => !cancelled && runGeneration === liveRunGenerationRef.current;

    const queueNext = (delay = LIVE_CAPTURE_INTERVAL_MS) => {
      if (isCurrentRun()) {
        timeoutId = window.setTimeout(run, delay);
      }
    };

    const run = async () => {
      let manuallyQueuedNext = false;
      if (!isCurrentRun()) {
        return;
      }

      const video = screenVideoRef.current;
      if (
        !video ||
        video.readyState < 2 ||
        video.videoWidth === 0 ||
        video.videoHeight === 0
      ) {
        if (isCurrentRun()) {
          timeoutId = window.setTimeout(run, 350);
        }
        return;
      }

      setIsRecognizing(true);
      setProgress({ phase: "image", message: "화면 분석", progress: 0.03 });
      try {
        const forceFullRecognition = forceNextLiveRecognitionRef.current;
        forceNextLiveRecognitionRef.current = false;
        const frame = captureVideoFrame(video);
        const preview = await recognizeBoardFromCanvas(
          frame,
          (nextProgress) => {
            if (isCurrentRun()) {
              setProgress(nextProgress);
            }
          },
          { recognizeLetters: false },
        );
        const signature = gridStateSignature(preview.grid);
        const now = Date.now();
        if (!hasColoredTiles(preview.grid)) {
          if (isCurrentRun()) {
            setGrid(createEmptyGrid());
            setWarnings([]);
            liveRecognizedSignatureRef.current = "";
            liveRecognizedAtRef.current = 0;
            liveLetterAttemptRef.current = null;
            livePendingSignatureRef.current = { signature: "", count: 0 };
            forceNextLiveRecognitionRef.current = false;
            setProgress({ phase: "done", message: "새 게임 감지", progress: 1 });
          }
          return;
        }

        const stableCount = forceFullRecognition
          ? LIVE_REQUIRED_STABLE_FRAMES
          : updateStableSignature(signature, livePendingSignatureRef);
        if (forceFullRecognition) {
          livePendingSignatureRef.current = { signature, count: LIVE_REQUIRED_STABLE_FRAMES };
        }
        if (stableCount < LIVE_REQUIRED_STABLE_FRAMES) {
          if (isCurrentRun()) {
            setGrid((current) => mergeGridStates(current, preview.grid));
            setWarnings(preview.warnings);
            setProgress({ phase: "image", message: "그리드 안정화", progress: 0.18 });
            manuallyQueuedNext = true;
            queueNext(LIVE_STABLE_FRAME_DELAY_MS);
          }
          return;
        }

        if (
          !forceFullRecognition &&
          signature === liveRecognizedSignatureRef.current &&
          now - liveRecognizedAtRef.current < LIVE_LETTER_REFRESH_INTERVAL_MS
        ) {
          if (isCurrentRun()) {
            setWarnings(preview.warnings);
            setProgress({ phase: "done", message: "변경 없음", progress: 1 });
          }
          return;
        }

        const lastAttempt = liveLetterAttemptRef.current;
        if (
          !forceFullRecognition &&
          lastAttempt?.signature === signature &&
          now - lastAttempt.time < LIVE_LETTER_RETRY_INTERVAL_MS
        ) {
          if (isCurrentRun()) {
            setGrid((current) => mergeGridStates(current, preview.grid));
            setWarnings(preview.warnings);
            setProgress({ phase: "done", message: "글자 인식 대기", progress: 1 });
          }
          return;
        }

        liveLetterAttemptRef.current = { signature, time: now };
        const result = await recognizeBoardFromCanvas(frame, (nextProgress) => {
          if (isCurrentRun()) {
            setProgress(nextProgress);
          }
        });
        if (isCurrentRun()) {
          setGrid(result.grid);
          setWarnings(result.warnings);
          if (hasCompleteRecognizedLetters(result.grid)) {
            liveRecognizedSignatureRef.current = signature;
            liveRecognizedAtRef.current = Date.now();
            liveLetterAttemptRef.current = null;
          }
        }
      } catch (error) {
        if (isCurrentRun()) {
          setWarnings([error instanceof Error ? error.message : "화면 인식에 실패했습니다."]);
        }
      } finally {
        if (isCurrentRun()) {
          setIsRecognizing(false);
          if (!manuallyQueuedNext) {
            queueNext();
          }
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [isScreenSharing, liveRecognitionRequestId]);

  useEffect(() => {
    return () => {
      screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
        item.type.startsWith("image/"),
      );
      if (file && !isScreenSharing) {
        event.preventDefault();
        void handleImageFile(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleImageFile, isScreenSharing]);

  const clearGrid = useCallback(() => {
    if (isScreenSharing) {
      stopScreenShare();
    }
    setGrid(createEmptyGrid());
    setWarnings([]);
    setProgress(null);
    setActiveTool("letter");
    localStorage.removeItem(STORAGE_KEY);
  }, [isScreenSharing, stopScreenShare]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Whint</h1>
          <p>Wordle Solver</p>
        </div>
      </header>

      <section className="workspace">
        <div className="input-column">
          <BoardGrid
            activeTool={activeTool}
            grid={grid}
            validWords={validWords}
            onApplyState={handleApplyState}
            onKeyMove={handleKeyMove}
            onLetterChange={handleLetterChange}
            onToolChange={setActiveTool}
          />
          <ImageImport
            isBusy={isRecognizing}
            isScreenSharing={isScreenSharing}
            progress={progress}
            warnings={warnings}
            onClear={clearGrid}
            onFile={handleImageFile}
            onForceScreenRecognition={forceScreenRecognition}
            onStartScreenShare={startScreenShare}
            onStopScreenShare={stopScreenShare}
          />
          {loadError && <p className="error-message">{loadError}</p>}
          {source && (
            <p className="source-note">
              {source.count.toLocaleString()} allowed guesses · {source.license} · NYT official list 아님
            </p>
          )}
        </div>

        <ResultsPanel
          candidates={candidates}
          completedRows={completedRows}
          grid={grid}
          recommendations={recommendations}
        />
      </section>
    </main>
  );
}

function captureVideoFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  const scale = Math.min(1, LIVE_CAPTURE_MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("화면 프레임을 읽을 수 없습니다.");
  }

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function gridStateSignature(grid: Grid): string {
  return grid.map((row) => row.map((cell) => cell.state[0]).join("")).join("/");
}

function updateStableSignature(
  signature: string,
  ref: { current: { signature: string; count: number } },
): number {
  if (ref.current.signature === signature) {
    ref.current = { signature, count: ref.current.count + 1 };
  } else {
    ref.current = { signature, count: 1 };
  }
  return ref.current.count;
}

function hasColoredTiles(grid: Grid): boolean {
  return grid.some((row) => row.some((cell) => cell.state !== "blank"));
}

function hasCompleteRecognizedLetters(grid: Grid): boolean {
  const rowsWithColors = grid.filter((row) => row.some((cell) => cell.state !== "blank"));
  return (
    rowsWithColors.length > 0 &&
    rowsWithColors.every((row) =>
      row.every((cell) => cell.state === "blank" || /^[A-Z]$/.test(cell.letter)),
    )
  );
}

function mergeGridStates(current: Grid, nextStates: Grid): Grid {
  return nextStates.map((row, rowIndex) =>
    row.map((cell, colIndex) => {
      const previous = current[rowIndex]?.[colIndex];
      const isSameState = previous?.state === cell.state;
      return {
        letter: cell.state === "blank" ? "" : (previous?.letter ?? ""),
        state: cell.state,
        confidence: isSameState ? previous?.confidence : undefined,
      };
    }),
  );
}

function loadSavedState(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<SavedState>;
    if (!isValidGrid(parsed.grid) || !isValidTool(parsed.activeTool)) {
      return null;
    }
    return {
      grid: parsed.grid,
      activeTool: parsed.activeTool,
    };
  } catch {
    return null;
  }
}

function saveState(state: SavedState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage failures such as private mode quota restrictions.
  }
}

function isValidGrid(value: unknown): value is Grid {
  return (
    Array.isArray(value) &&
    value.length === 6 &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 5 &&
        row.every(
          (cell) =>
            cell &&
            typeof cell === "object" &&
            "letter" in cell &&
            "state" in cell &&
            typeof cell.letter === "string" &&
            isValidCellState(cell.state),
        ),
    )
  );
}

function isValidTool(value: unknown): value is BoardTool {
  return value === "letter" || isValidCellState(value);
}

function isValidCellState(value: unknown): value is CellState {
  return value === "blank" || value === "absent" || value === "present" || value === "correct";
}
