import type { CellState, Grid } from "../lib/types";

export type BoardTool = "letter" | CellState;

interface BoardGridProps {
  grid: Grid;
  activeTool: BoardTool;
  validWords: Set<string>;
  onToolChange: (tool: BoardTool) => void;
  onApplyState: (row: number, col: number, state: CellState) => void;
  onLetterChange: (row: number, col: number, value: string) => void;
  onKeyMove: (row: number, col: number, event: React.KeyboardEvent<HTMLInputElement>) => void;
}

const STATE_LABELS: Record<CellState, string> = {
  blank: "빈칸",
  absent: "없음",
  present: "포함",
  correct: "정확",
};

const TOOLS: Array<{ tool: BoardTool; label: string }> = [
  { tool: "letter", label: "입력" },
  { tool: "absent", label: "회색" },
  { tool: "present", label: "노랑" },
  { tool: "correct", label: "초록" },
  { tool: "blank", label: "지우기" },
];

export function BoardGrid({
  grid,
  activeTool,
  validWords,
  onApplyState,
  onKeyMove,
  onLetterChange,
  onToolChange,
}: BoardGridProps) {
  const applyTool = (row: number, col: number) => {
    if (activeTool !== "letter") {
      onApplyState(row, col, activeTool);
    }
  };

  return (
    <section className="board-panel" aria-label="Wordle 입력">
      <div className="tool-palette" aria-label="입력 모드">
        {TOOLS.map((item) => (
          <button
            className={`tool-button tool-${item.tool} ${activeTool === item.tool ? "is-active" : ""}`}
            key={item.tool}
            type="button"
            onClick={() => onToolChange(item.tool)}
          >
            <span className={`tool-swatch tile-${item.tool}`} />
            <span>{item.label}</span>
          </button>
        ))}
      </div>
      <div className={`board ${activeTool === "letter" ? "is-letter-mode" : "is-paint-mode"}`}>
        {grid.map((row, rowIndex) => (
          <div className="board-row-shell" key={rowIndex}>
            <RowStatus row={row} validWords={validWords} />
            <div className="board-row">
              {row.map((cell, colIndex) => (
                <div
                  className={`tile tile-${cell.state}`}
                  key={`${rowIndex}-${colIndex}`}
                  onClick={() => applyTool(rowIndex, colIndex)}
                >
                  <input
                    aria-label={`${rowIndex + 1}행 ${colIndex + 1}열 ${STATE_LABELS[cell.state]}`}
                    data-cell={`${rowIndex}-${colIndex}`}
                    inputMode="text"
                    maxLength={1}
                    readOnly={activeTool !== "letter"}
                    value={cell.letter}
                    onChange={(event) => onLetterChange(rowIndex, colIndex, event.target.value)}
                    onClick={(event) => {
                      if (activeTool !== "letter") {
                        event.stopPropagation();
                        event.currentTarget.blur();
                        applyTool(rowIndex, colIndex);
                      }
                    }}
                    onKeyDown={(event) => onKeyMove(rowIndex, colIndex, event)}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RowStatus({ row, validWords }: { row: Grid[number]; validWords: Set<string> }) {
  const status = getRowStatus(row, validWords);
  return (
    <div className={`row-status row-status-${status.kind}`} title={status.title}>
      <span>{status.label}</span>
    </div>
  );
}

function getRowStatus(row: Grid[number], validWords: Set<string>) {
  const letters = row.map((cell) => cell.letter).join("");
  const hasAnyInput = row.some((cell) => cell.letter || cell.state !== "blank");
  const hasAllLetters = row.every((cell) => /^[A-Z]$/.test(cell.letter));
  const hasAllColors = row.every((cell) => cell.state !== "blank");

  if (!hasAnyInput) {
    return { kind: "empty", label: "·", title: "빈 행" };
  }
  if (!hasAllLetters) {
    return { kind: "missing", label: "글", title: "글자가 부족합니다" };
  }
  if (validWords.size === 0) {
    return { kind: "pending", label: "…", title: "단어 목록을 불러오는 중입니다" };
  }
  if (!validWords.has(letters.toLowerCase())) {
    return { kind: "invalid", label: "X", title: "단어 목록에 없는 단어입니다" };
  }
  if (!hasAllColors) {
    return { kind: "missing", label: "색", title: "회색/노랑/초록 표시가 부족합니다" };
  }
  return { kind: "ready", label: "OK", title: "완성된 유효 단어입니다" };
}
