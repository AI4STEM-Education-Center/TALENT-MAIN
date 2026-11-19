// Shared gate for every quiz-variant provider call (worker generation and
// verification, the synchronous sample preview, manual retries). Several
// streaming calls may run at once, but starts are spaced out and a transient
// provider error (429 / 5xx / connection drop) puts every caller into one
// shared cooldown, so a rate-limited provider is not hammered by the other
// in-flight jobs while one of them backs off.
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MIN_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

export function isTransientAiError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { status, name } = error as { status?: number; name?: string };
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    (typeof status === "number" && status >= 500 && status <= 599) ||
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError"
  );
}

function retryAfterMs(error: unknown): number {
  const headers = (error as { headers?: Headers })?.headers;
  if (typeof headers?.get !== "function") return 0;
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds !== null && Number.isFinite(Number(milliseconds)))
    return Math.max(0, Number(milliseconds));
  const value = headers.get("retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export type QuizVariantRequestGateOptions = {
  /** Provider calls allowed in flight at once (each holds its slot through retries). */
  maxConcurrent?: number;
  /** Minimum spacing between consecutive call starts, across all callers. */
  minIntervalMs?: number;
};

export function createQuizVariantRequestGate({
  maxConcurrent = DEFAULT_MAX_CONCURRENT,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
}: QuizVariantRequestGateOptions = {}) {
  const limit = Math.max(1, Math.floor(maxConcurrent));
  let active = 0;
  const waiting: (() => void)[] = [];
  // Earliest moment the next call may start (start spacing).
  let nextStart = 0;
  // Shared Retry-After / backoff window: no caller starts before this.
  let cooldownUntil = 0;

  async function acquire() {
    if (active < limit) {
      active++;
      return;
    }
    // release() hands its slot straight to us, so `active` stays unchanged.
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
  async function waitForTurn() {
    for (;;) {
      const now = Date.now();
      const start = Math.max(now, nextStart, cooldownUntil);
      // Reserve the start slot synchronously so concurrent callers queue
      // behind each other rather than all waking at the same instant.
      nextStart = start + minIntervalMs;
      if (start > now) await sleep(start - now);
      // Another caller may have hit a rate limit while we slept.
      if (cooldownUntil <= Date.now()) return;
    }
  }

  return async function request<T>(call: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      for (let attempt = 0; ; attempt++) {
        await waitForTurn();
        try {
          return await call();
        } catch (error) {
          if (!isTransientAiError(error)) throw error;
          const delay = Math.max(
            retryAfterMs(error),
            Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000,
          );
          // Even an exhausted request leaves a cooldown for every other caller.
          cooldownUntil = Math.max(
            cooldownUntil,
            Date.now() + Math.min(delay, MAX_RETRY_DELAY_MS),
          );
          if (attempt + 1 >= MAX_ATTEMPTS || delay > MAX_RETRY_DELAY_MS)
            throw error;
        }
      }
    } finally {
      release();
    }
  };
}

export const requestQuizVariant = createQuizVariantRequestGate();
