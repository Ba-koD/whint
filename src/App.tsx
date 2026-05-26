import { useCallback, useEffect, useMemo, useState } from "react";
import { BoardGrid, type BoardTool } from "./components/BoardGrid";
import { ImageImport } from "./components/ImageImport";
import { ResultsPanel } from "./components/ResultsPanel";
import { recognizeBoardFromImage, type RecognitionProgress } from "./lib/imageRecognition";
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
  const [progress, setProgress] = useState<RecognitionProgress | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [activeTool, setActiveTool] = useState<BoardTool>(savedState?.activeTool ?? "letter");

  useEffect(() => {
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

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
        item.type.startsWith("image/"),
      );
      if (file) {
        event.preventDefault();
        void handleImageFile(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handleImageFile]);

  const clearGrid = useCallback(() => {
    setGrid(createEmptyGrid());
    setWarnings([]);
    setProgress(null);
    setActiveTool("letter");
    localStorage.removeItem(STORAGE_KEY);
  }, []);

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
            progress={progress}
            warnings={warnings}
            onClear={clearGrid}
            onFile={handleImageFile}
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
