import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SOURCE_URL = "https://raw.githubusercontent.com/tabatkins/wordle-list/main/words";
const LICENSE_URL = "https://github.com/tabatkins/wordle-list/blob/main/LICENSE";
const outDir = path.resolve("public");
const wordsPath = path.join(outDir, "words.json");
const sourcePath = path.join(outDir, "word-source.json");

async function loadExistingWords() {
  try {
    const raw = await readFile(wordsPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

async function fetchWords() {
  const response = await fetch(SOURCE_URL);
  if (!response.ok) {
    throw new Error(`Failed to fetch word list: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  return Array.from(
    new Set(
      text
        .split(/\r?\n/)
        .map((word) => word.trim().toLowerCase())
        .filter((word) => /^[a-z]{5}$/.test(word)),
    ),
  );
}

await mkdir(outDir, { recursive: true });

let words;
let fetched = false;
try {
  words = await fetchWords();
  fetched = true;
} catch (error) {
  words = await loadExistingWords();
  if (!words) {
    throw error;
  }
  console.warn(`Using existing public/words.json because fetch failed: ${error.message}`);
}

if (words.length < 1000) {
  throw new Error(`Word list looks too small: ${words.length}`);
}

await writeFile(wordsPath, `${JSON.stringify(words)}\n`);
await writeFile(
  sourcePath,
  `${JSON.stringify(
    {
      source: SOURCE_URL,
      license: "MIT",
      licenseUrl: LICENSE_URL,
      count: words.length,
      fetchedAt: fetched ? new Date().toISOString() : null,
    },
    null,
    2,
  )}\n`,
);

console.log(`Prepared ${words.length} Wordle words in public/words.json`);
