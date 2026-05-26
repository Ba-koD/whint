import type { WordSource } from "./types";

export async function loadWordData(): Promise<{ words: string[]; source: WordSource | null }> {
  const base = import.meta.env.BASE_URL || "./";
  const wordsResponse = await fetch(`${base}words.json`);
  if (!wordsResponse.ok) {
    throw new Error("단어 목록을 불러오지 못했습니다.");
  }

  const words = (await wordsResponse.json()) as string[];
  let source: WordSource | null = null;

  try {
    const sourceResponse = await fetch(`${base}word-source.json`);
    if (sourceResponse.ok) {
      source = (await sourceResponse.json()) as WordSource;
    }
  } catch {
    source = null;
  }

  cachedWords = words.filter((word) => /^[a-z]{5}$/.test(word));

  return {
    words: cachedWords,
    source,
  };
}

let cachedWords: string[] | null = null;

export async function getCachedWords(): Promise<string[]> {
  if (!cachedWords) {
    const data = await loadWordData();
    cachedWords = data.words;
  }
  return cachedWords;
}
