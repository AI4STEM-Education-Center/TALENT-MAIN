/**
 * Per-attempt answer-choice ordering.
 *
 * Serving choices in their authored order makes multi-attempt feedback cheaper
 * than it should be: the submit response tells a student which questions they
 * got wrong, so on the next attempt they can walk a fixed list by position
 * ("it wasn't the second one") without ever engaging with the question.
 * Reordering per attempt removes the positional shortcut. Grading is untouched
 * — the client submits option IDs, so order is purely presentational.
 *
 * The order is DERIVED rather than stored: it is seeded from the attempt id and
 * question id, so a student who closes the tab and resumes the same attempt
 * sees the same layout, while a fresh attempt gets a fresh one. Nothing the
 * client sends feeds the seed.
 */

/** FNV-1a, 32-bit. Small, dependency-free, and stable across Node versions. */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32 — a compact seeded PRNG. Not cryptographic; it doesn't need to be. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates against a seeded PRNG. Same seed in, same permutation out. */
export function shuffleWithSeed<T>(items: T[], seed: string): T[] {
  const shuffled = [...items];
  const random = mulberry32(hashSeed(seed));
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Choices whose meaning depends on being last. Shuffling "None of the above"
 * into slot 2 reads as a bug to teachers and students alike, so these keep
 * their trailing position (and their order relative to each other) while
 * everything above them is reordered.
 */
const ANCHORED_LAST = /^\s*\W*\s*(all|none|both|neither)\s+of\s+(the\s+|these\s+)?(above|below|these|them|options)\b/i;

/** Reorder a question's answer choices for one attempt. */
export function shuffleAnswerChoices<T extends { text: string }>(
  options: T[],
  seed: string
): T[] {
  if (options.length < 2) return options;

  const movable: T[] = [];
  const anchored: T[] = [];
  for (const option of options) {
    (ANCHORED_LAST.test(option.text) ? anchored : movable).push(option);
  }

  return [...shuffleWithSeed(movable, seed), ...anchored];
}
