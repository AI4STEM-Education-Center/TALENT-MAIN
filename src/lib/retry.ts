// Shared retry/backoff helper for impure LLM/S3 calls. Lifted verbatim out of
// `vlm-engine.ts` so multiple engines (vlm-engine, quiz-extraction-engine) can
// reuse the same exponential-backoff behavior without duplicating it.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retryWithExponentialBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 500,
  maxDelayMs = 5000
): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error: any) {
      attempt++;
      if (attempt >= maxRetries) throw error;

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      console.warn(`[Retry] Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw new Error("Unreachable");
}
