// The quiz-variant consumer runs jobs serially. Share this gate across jobs,
// including manual retries and validation, to avoid bursts at the provider.
const MIN_INTERVAL_MS = 2000;
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

export function createQuizVariantRequestGate() {
  let tail: Promise<unknown> = Promise.resolve();
  let nextStart = 0;
  return function request<T>(call: () => Promise<T>): Promise<T> {
    const result = tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const wait = nextStart - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        nextStart = Date.now() + MIN_INTERVAL_MS;
        try {
          return await call();
        } catch (error) {
          if (!isTransientAiError(error)) throw error;
          const delay = Math.max(
            retryAfterMs(error),
            Math.min(60_000, 2000 * 2 ** attempt) + Math.random() * 1000,
          );
          // Even an exhausted request leaves a cooldown for the next job.
          nextStart = Math.max(nextStart, Date.now() + delay);
          if (attempt + 1 >= MAX_ATTEMPTS || delay > MAX_RETRY_DELAY_MS)
            throw error;
        }
      }
    });
    tail = result.catch(() => undefined);
    return result;
  };
}

export const requestQuizVariant = createQuizVariantRequestGate();
