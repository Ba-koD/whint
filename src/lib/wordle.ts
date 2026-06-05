import type { Cell, CellState, CompletedGuess, Grid, Recommendation } from "./types";

export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;

const ACTIVE_STATES: Exclude<CellState, "blank">[] = ["absent", "present", "correct"];
const FEEDBACK_PATTERN_COUNT = 3 ** WORD_LENGTH;
const SOLVED_FEEDBACK_CODE = FEEDBACK_PATTERN_COUNT - 1;
const FREQUENCY_POSITION_WEIGHT = 0.8;
const FREQUENCY_COVERAGE_WEIGHT = 0.25;
const FREQUENCY_UNUSED_FREQUENCY_WEIGHT = 0.65;
const FREQUENCY_UNUSED_POSITION_WEIGHT = 0.45;
const FREQUENCY_UNUSED_COUNT_WEIGHT = 0.12;
const FREQUENCY_DUPLICATE_PENALTY = 0.15;

interface LetterStats {
  positionCounts: Map<string, number>[];
  uniqueCounts: Map<string, number>;
  total: number;
}

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
  const usedLetters = getUsedLetters(grid);
  const normalizedWords = uniqueWords(
    words.map(normalizeWord).filter((word) => word.length === WORD_LENGTH),
  );
  const playableWords = normalizedWords.filter((word) => guessRespectsKnownHints(word, grid));
  const guesses = uniqueWords([...candidates, ...playableWords]);

  if (candidates.length === 0) {
    return [];
  }

  if (candidates.length <= 1) {
    return candidates.map((word) => ({
      word,
      score: candidates.length,
      method: "elimination" as const,
      expectedRemaining: 0,
      worstRemaining: 0,
    }));
  }

  const recommendations = (() => {
    if (candidates.length <= 250) {
      return rankByExpectedElimination(guesses, candidates);
    }
    if (candidates.length <= 700) {
      return rankByExpectedElimination(
        buildProbePool(guesses, candidates, 650, usedLetters, true),
        candidates,
      );
    }
    return rankByExpectedElimination(
      buildProbePool(guesses, candidates, 900, usedLetters, false),
      candidates,
    );
  })();

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

function rankByExpectedElimination(guesses: string[], answers: string[]): Recommendation[] {
  const answerSet = new Set(answers);
  const answerCount = answers.length;

  return guesses
    .map((guess) => {
      const buckets = Array.from({ length: FEEDBACK_PATTERN_COUNT }, () => 0);
      for (const answer of answers) {
        buckets[feedbackCodeFor(guess, answer)] += 1;
      }

      let retainedCandidateTotal = 0;
      let worstRemaining = 0;
      for (let code = 0; code < buckets.length; code += 1) {
        const size = buckets[code];
        if (size === 0) {
          continue;
        }

        const remainingAfterFeedback =
          answerSet.has(guess) && code === SOLVED_FEEDBACK_CODE ? 0 : size;
        retainedCandidateTotal += size * remainingAfterFeedback;
        worstRemaining = Math.max(worstRemaining, remainingAfterFeedback);
      }

      const expectedRemaining = retainedCandidateTotal / answerCount;
      return {
        word: guess,
        score: answerCount - expectedRemaining,
        method: "elimination" as const,
        expectedRemaining,
        worstRemaining,
      };
    })
    .sort(compareRecommendations);
}

function buildProbePool(
  words: string[],
  candidates: string[],
  limit: number,
  usedLetters = new Set<string>(),
  includeAllCandidates = false,
): string[] {
  const rankedWords = rankByLetterFrequency(words, candidates, usedLetters)
    .slice(0, limit)
    .map((item) => item.word);

  if (includeAllCandidates) {
    return uniqueWords([...candidates, ...rankedWords]);
  }

  const candidateLimit = Math.max(80, Math.floor(limit * 0.25));
  const rankedCandidates = rankByLetterFrequency(candidates, candidates, usedLetters)
    .slice(0, candidateLimit)
    .map((item) => item.word);

  return uniqueWords([
    ...rankedCandidates,
    ...rankedWords,
  ]);
}

function rankByLetterFrequency(
  guesses: string[],
  referenceWords = guesses,
  usedLetters = new Set<string>(),
): Recommendation[] {
  const stats = buildLetterStats(referenceWords);

  return guesses
    .map((word) => {
      const uniqueLetters = new Set(word);
      const { coverageScore, unusedCoverageScore, unusedLetterCount } = getLetterCoverageScores(
        uniqueLetters,
        stats,
        usedLetters,
      );
      const { positionScore, unusedPositionScore } = getPositionCoverageScores(
        word,
        stats,
        usedLetters,
      );
      const duplicatePenalty = WORD_LENGTH - uniqueLetters.size;

      return {
        word,
        score:
          positionScore * FREQUENCY_POSITION_WEIGHT +
          coverageScore * FREQUENCY_COVERAGE_WEIGHT +
          unusedCoverageScore * FREQUENCY_UNUSED_FREQUENCY_WEIGHT +
          unusedPositionScore * FREQUENCY_UNUSED_POSITION_WEIGHT +
          unusedLetterCount * FREQUENCY_UNUSED_COUNT_WEIGHT -
          duplicatePenalty * FREQUENCY_DUPLICATE_PENALTY,
        method: "frequency" as const,
      };
    })
    .sort(compareRecommendations);
}

function uniqueWords(words: string[]): string[] {
  return [...new Set(words)];
}

function buildLetterStats(referenceWords: string[]): LetterStats {
  const total = Math.max(referenceWords.length, 1);
  const positionCounts = Array.from({ length: WORD_LENGTH }, () => new Map<string, number>());
  const uniqueCounts = new Map<string, number>();

  for (const word of referenceWords) {
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

  return { positionCounts, uniqueCounts, total };
}

function getLetterCoverageScores(
  uniqueLetters: Set<string>,
  stats: LetterStats,
  usedLetters: Set<string>,
) {
  let coverageScore = 0;
  let unusedCoverageScore = 0;
  let unusedLetterCount = 0;

  for (const letter of uniqueLetters) {
    const letterFrequency = (stats.uniqueCounts.get(letter) ?? 0) / stats.total;
    coverageScore += letterFrequency;

    if (!usedLetters.has(letter)) {
      unusedCoverageScore += letterFrequency;
      unusedLetterCount += 1;
    }
  }

  return { coverageScore, unusedCoverageScore, unusedLetterCount };
}

function getPositionCoverageScores(word: string, stats: LetterStats, usedLetters: Set<string>) {
  let positionScore = 0;
  let unusedPositionScore = 0;

  for (let index = 0; index < WORD_LENGTH; index += 1) {
    const letter = word[index];
    const positionFrequency = (stats.positionCounts[index].get(letter) ?? 0) / stats.total;
    positionScore += positionFrequency;

    if (!usedLetters.has(letter)) {
      unusedPositionScore += positionFrequency;
    }
  }

  return { positionScore, unusedPositionScore };
}

function getUsedLetters(grid: Grid): Set<string> {
  const usedLetters = new Set<string>();

  for (const row of grid) {
    for (const cell of row) {
      const letter = cell.letter.toLowerCase();
      if (/^[a-z]$/.test(letter) && ACTIVE_STATES.includes(cell.state as never)) {
        usedLetters.add(letter);
      }
    }
  }

  return usedLetters;
}

function guessRespectsKnownHints(word: string, grid: Grid): boolean {
  const fixedByPosition = new Map<number, string>();
  const disallowedPositions = new Map<string, Set<number>>();
  const bannedLetters = new Set<string>();
  const minCounts = new Map<string, number>();

  for (const row of grid) {
    const rowLetters = row.map((cell) => cell.letter.toLowerCase());
    const confirmedCounts = new Map<string, number>();

    for (let index = 0; index < WORD_LENGTH; index += 1) {
      const letter = rowLetters[index];
      const state = row[index].state;
      if (!/^[a-z]$/.test(letter) || state === "blank") {
        continue;
      }

      if (state === "correct") {
        fixedByPosition.set(index, letter);
        confirmedCounts.set(letter, (confirmedCounts.get(letter) ?? 0) + 1);
      } else if (state === "present") {
        addDisallowedPosition(disallowedPositions, letter, index);
        confirmedCounts.set(letter, (confirmedCounts.get(letter) ?? 0) + 1);
      } else {
        bannedLetters.add(letter);
      }
    }

    for (const [letter, count] of confirmedCounts) {
      minCounts.set(letter, Math.max(minCounts.get(letter) ?? 0, count));
    }
  }

  for (const letter of bannedLetters) {
    if (word.includes(letter)) {
      return false;
    }
  }

  for (const [position, letter] of fixedByPosition) {
    if (word[position] !== letter) {
      return false;
    }
  }

  for (const [letter, positions] of disallowedPositions) {
    for (const position of positions) {
      if (word[position] === letter) {
        return false;
      }
    }
  }

  for (const [letter, count] of minCounts) {
    if (countLetters(word, letter) < count) {
      return false;
    }
  }

  return true;
}

function addDisallowedPosition(
  positionsByLetter: Map<string, Set<number>>,
  letter: string,
  position: number,
) {
  const positions = positionsByLetter.get(letter) ?? new Set<number>();
  positions.add(position);
  positionsByLetter.set(letter, positions);
}

function countLetters(word: string, letter: string): number {
  let count = 0;
  for (const current of word) {
    if (current === letter) {
      count += 1;
    }
  }
  return count;
}

function compareRecommendations(a: Recommendation, b: Recommendation): number {
  const scoreDifference = b.score - a.score;
  if (Math.abs(scoreDifference) <= 0.005) {
    const worstRemainingDifference = (a.worstRemaining ?? Infinity) - (b.worstRemaining ?? Infinity);
    if (!Number.isNaN(worstRemainingDifference) && worstRemainingDifference !== 0) {
      return worstRemainingDifference;
    }

    const expectedRemainingDifference =
      (a.expectedRemaining ?? Infinity) - (b.expectedRemaining ?? Infinity);
    if (!Number.isNaN(expectedRemainingDifference) && expectedRemainingDifference !== 0) {
      return expectedRemainingDifference;
    }

    const duplicateDifference = repeatedLetterCount(a.word) - repeatedLetterCount(b.word);
    if (duplicateDifference !== 0) {
      return duplicateDifference;
    }
  }

  if (scoreDifference !== 0) {
    return scoreDifference;
  }
  return a.word.localeCompare(b.word);
}

function repeatedLetterCount(word: string): number {
  return WORD_LENGTH - new Set(word).size;
}

function feedbackCodeFor(guess: string, answer: string): number {
  let state0 = 0;
  let state1 = 0;
  let state2 = 0;
  let state3 = 0;
  let state4 = 0;
  let remaining = "";

  if (guess[0] === answer[0]) {
    state0 = 2;
  } else {
    remaining += answer[0];
  }
  if (guess[1] === answer[1]) {
    state1 = 2;
  } else {
    remaining += answer[1];
  }
  if (guess[2] === answer[2]) {
    state2 = 2;
  } else {
    remaining += answer[2];
  }
  if (guess[3] === answer[3]) {
    state3 = 2;
  } else {
    remaining += answer[3];
  }
  if (guess[4] === answer[4]) {
    state4 = 2;
  } else {
    remaining += answer[4];
  }

  if (state0 !== 2) {
    const position = remaining.indexOf(guess[0]);
    if (position !== -1) {
      state0 = 1;
      remaining = removeLetterAt(remaining, position);
    }
  }
  if (state1 !== 2) {
    const position = remaining.indexOf(guess[1]);
    if (position !== -1) {
      state1 = 1;
      remaining = removeLetterAt(remaining, position);
    }
  }
  if (state2 !== 2) {
    const position = remaining.indexOf(guess[2]);
    if (position !== -1) {
      state2 = 1;
      remaining = removeLetterAt(remaining, position);
    }
  }
  if (state3 !== 2) {
    const position = remaining.indexOf(guess[3]);
    if (position !== -1) {
      state3 = 1;
      remaining = removeLetterAt(remaining, position);
    }
  }
  if (state4 !== 2) {
    const position = remaining.indexOf(guess[4]);
    if (position !== -1) {
      state4 = 1;
    }
  }

  return (((state0 * 3 + state1) * 3 + state2) * 3 + state3) * 3 + state4;
}

function removeLetterAt(value: string, index: number): string {
  return value.slice(0, index) + value.slice(index + 1);
}
