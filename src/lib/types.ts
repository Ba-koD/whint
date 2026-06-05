export type CellState = "blank" | "absent" | "present" | "correct";

export interface Cell {
  letter: string;
  state: CellState;
  confidence?: number;
}

export type Grid = Cell[][];

export interface CompletedGuess {
  word: string;
  states: Exclude<CellState, "blank">[];
}

export interface Recommendation {
  word: string;
  score: number;
  method: "elimination" | "frequency";
  expectedRemaining?: number;
  worstRemaining?: number;
}

export interface WordSource {
  source: string;
  license: string;
  licenseUrl: string;
  count: number;
  fetchedAt: string | null;
}
