import type { Cell, CellState, CompletedGuess, Grid, Recommendation } from "./types";

export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;

const ACTIVE_STATES: Exclude<CellState, "blank">[] = ["absent", "present", "correct"];

export function createEmptyGrid(): Grid {
  return Array.from({ length: MAX_GUESSES }, () =>
    Array.from({ length: WORD_LENGTH }, () => ({ letter: "", state: "blank" as const })),
  );
}

export function normalizeLetter(value: string): string {
  const match = value.toUpperCase().match(/[A-Z]/);
  return match?.[0] ?? "";
}

export function normalizeWord(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, "").slice(0, WORD_LENGTH);
}

export function nextState(state: CellState): CellState {
  switch (state) {
    case "blank":
      return "absent";
    case "absent":
      return "present";
    case "present":
      return "correct";
    case "correct":
      return "blank";
  }
}

export function isCompletedRow(row: Cell[]): boolean {
  return (
    row.length === WORD_LENGTH &&
    row.every((cell) => /^[A-Z]$/.test(cell.letter) && ACTIVE_STATES.includes(cell.state as never))
  );
}

export function getCompletedGuesses(grid: Grid): CompletedGuess[] {
  return grid.filter(isCompletedRow).map((row) => ({
    word: row.map((cell) => cell.letter).join("").toLowerCase(),
    states: row.map((cell) => cell.state as Exclude<CellState, "blank">),
  }));
}

export function feedbackFor(guess: string, answer: string): Exclude<CellState, "blank">[] {
  const guessLetters = normalizeWord(guess).split("");
  const answerLetters = normalizeWord(answer).split("");

  if (guessLetters.length !== WORD_LENGTH || answerLetters.length !== WORD_LENGTH) {
    throw new Error("feedbackFor expects two five-letter words");
  }

  const feedback: Exclude<CellState, "blank">[] = Array.from({ length: WORD_LENGTH }, () => "absent");
  const remaining = new Map<string, number>();

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    if (guessLetters[index] === answerLetters[index]) {
      feedback[index] = "correct";
    } else {
      const letter = answerLetters[index];
      remaining.set(letter, (remaining.get(letter) ?? 0) + 1);
    }
  }

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    if (feedback[index] === "correct") {
      continue;
    }

    const letter = guessLetters[index];
    const count = remaining.get(letter) ?? 0;
    if (count > 0) {
      feedback[index] = "present";
      remaining.set(letter, count - 1);
    }
  }

  return feedback;
}

export function rowMatchesAnswer(row: CompletedGuess, answer: string): boolean {
  const expected = feedbackFor(row.word, answer);
  return expected.every((state, index) => state === row.states[index]);
}

export function filterCandidates(words: string[], grid: Grid): string[] {
  const guesses = getCompletedGuesses(grid);
  const normalizedWords = words.map(normalizeWord).filter((word) => word.length === WORD_LENGTH);

  if (guesses.length === 0) {
    return normalizedWords;
  }

  return normalizedWords.filter((word) => guesses.every((guess) => rowMatchesAnswer(guess, word)));
}

export function getRecommendations(words: string[], grid: Grid, limit = 30): Recommendation[] {
  const candidates = filterCandidates(words, grid);
  if (candidates.length <= 1) {
    return candidates.map((word) => ({ word, score: 1, method: "frequency" as const }));
  }

  const recommendations =
    candidates.length <= 700
      ? rankByEntropy(candidates)
      : rankByLetterFrequency(candidates);

  return recommendations.slice(0, limit);
}

export function getCandidateEvidence(word: string, grid: Grid): Exclude<CellState, "blank">[] {
  const candidate = normalizeWord(word);
  const guesses = getCompletedGuesses(grid);
  const yellowLetters = new Set<string>();
  const greenByPosition = new Map<number, string>();

  for (const guess of guesses) {
    for (let index = 0; index < WORD_LENGTH; index += 1) {
      const letter = guess.word[index];
      if (guess.states[index] === "correct") {
        greenByPosition.set(index, letter);
      } else if (guess.states[index] === "present") {
        yellowLetters.add(letter);
      }
    }
  }

  return Array.from({ length: WORD_LENGTH }, (_, index) => {
    const letter = candidate[index];
    if (greenByPosition.get(index) === letter) {
      return "correct";
    }
    if (yellowLetters.has(letter)) {
      return "present";
    }
    return "absent";
  });
}

function rankByEntropy(candidates: string[]): Recommendation[] {
  return candidates
    .map((guess) => {
      const buckets = new Map<string, number>();
      for (const answer of candidates) {
        const key = feedbackFor(guess, answer).map(stateKey).join("");
        buckets.set(key, (buckets.get(key) ?? 0) + 1);
      }

      let entropy = 0;
      for (const size of buckets.values()) {
        const probability = size / candidates.length;
        entropy -= probability * Math.log2(probability);
      }

      return { word: guess, score: entropy, method: "entropy" as const };
    })
    .sort(compareRecommendations);
}

function rankByLetterFrequency(candidates: string[]): Recommendation[] {
  const positionCounts = Array.from({ length: WORD_LENGTH }, () => new Map<string, number>());
  const uniqueCounts = new Map<string, number>();

  for (const word of candidates) {
    const seen = new Set<string>();
    for (let index = 0; index < WORD_LENGTH; index += 1) {
      const letter = word[index];
      positionCounts[index].set(letter, (positionCounts[index].get(letter) ?? 0) + 1);
      seen.add(letter);
    }
    for (const letter of seen) {
      uniqueCounts.set(letter, (uniqueCounts.get(letter) ?? 0) + 1);
    }
  }

  return candidates
    .map((word) => {
      const uniqueLetters = new Set(word);
      const positionScore = [...word].reduce(
        (sum, letter, index) => sum + (positionCounts[index].get(letter) ?? 0) / candidates.length,
        0,
      );
      const coverageScore =
        [...uniqueLetters].reduce((sum, letter) => sum + (uniqueCounts.get(letter) ?? 0), 0) /
        candidates.length;
      const duplicatePenalty = WORD_LENGTH - uniqueLetters.size;

      return {
        word,
        score: positionScore + coverageScore * 0.35 - duplicatePenalty * 0.15,
        method: "frequency" as const,
      };
    })
    .sort(compareRecommendations);
}

function compareRecommendations(a: Recommendation, b: Recommendation): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }
  return a.word.localeCompare(b.word);
}

function stateKey(state: Exclude<CellState, "blank">): string {
  switch (state) {
    case "absent":
      return "0";
    case "present":
      return "1";
    case "correct":
      return "2";
  }
}
