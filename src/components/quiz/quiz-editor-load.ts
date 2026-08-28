/**
 * Initial data load for the quiz editor, kept out of the component so it can be
 * tested without a DOM.
 *
 * The editor previously did `fetch("/api/topics").then((r) => r.json())` with no
 * status check. `/api/topics` answers 401 with `{ error: "Unauthorized" }`, so
 * an expired session put that object into `topics` state and the render's
 * `topics.map(...)` threw — the editor white-screened instead of reporting the
 * failure. The surrounding `Promise.all(...).then(...)` also had no `.catch`, so
 * any rejection left `loading` stuck true behind a permanent "Loading…".
 *
 * Both statuses and shapes are therefore checked here: a non-2xx is an error, and
 * a 2xx carrying the wrong shape is *also* an error, because a proxy or an error
 * page can return 200 with a body the render cannot consume.
 */

/** A missing quiz is an expected outcome, distinct from a failed load. */
export type QuizEditorLoad<Quiz, Topic> =
  | { kind: "ok"; quiz: Quiz; topics: Topic[] }
  | { kind: "notFound" }
  /** Superseded by a newer request; the caller must not write any state. */
  | { kind: "aborted" }
  | { kind: "error"; message: string };

/**
 * Generic over the payload types on purpose: the validation here is structural
 * (an object for the quiz, an array for the topics) and genuinely does not
 * depend on the concrete field shapes, which stay owned by the component.
 */
export async function loadQuizEditorData<Quiz, Topic>(
  quizId: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<QuizEditorLoad<Quiz, Topic>> {
  try {
    const [quizRes, topicsRes] = await Promise.all([
      fetchImpl(`/api/quizzes/${encodeURIComponent(quizId)}`, { signal }),
      fetchImpl("/api/topics", { signal }),
    ]);

    // The proxy answers an expired session with a 307 to /login, which fetch
    // follows — yielding the login page's HTML under a 200. Detect that here so
    // the teacher is told to sign in, rather than being shown the JSON parse
    // error that reading an HTML body would otherwise produce.
    if (quizRes.redirected || topicsRes.redirected) {
      return { kind: "error", message: "Your session has expired. Please sign in again." };
    }

    if (quizRes.status === 404) return { kind: "notFound" };
    if (!quizRes.ok) {
      return { kind: "error", message: `Could not load this quiz (HTTP ${quizRes.status}).` };
    }
    if (!topicsRes.ok) {
      return { kind: "error", message: `Could not load the tag list (HTTP ${topicsRes.status}).` };
    }

    const [quizBody, topicsBody] = await Promise.all([quizRes.json(), topicsRes.json()]);

    // A 200 is not a promise about the body. `topics` is mapped directly in
    // render, and `quiz` is dereferenced field-by-field, so both are checked.
    if (typeof quizBody !== "object" || quizBody === null || Array.isArray(quizBody)) {
      return { kind: "error", message: "The quiz came back in an unexpected format." };
    }
    if (!Array.isArray(topicsBody)) {
      return { kind: "error", message: "The tag list came back in an unexpected format." };
    }

    return { kind: "ok", quiz: quizBody as Quiz, topics: topicsBody as Topic[] };
  } catch (cause) {
    // An abort is the expected path when quizId changes mid-flight, and a
    // rejected body read on an aborted request looks the same. Either way the
    // caller owns no state here.
    if (signal.aborted) return { kind: "aborted" };
    // Covers network failures and unparseable bodies. The underlying error is
    // logged rather than rendered: "Unexpected token '<'" means nothing to a
    // teacher, and the raw text can carry response content.
    console.error("Quiz editor load failed", cause);
    return {
      kind: "error",
      message: "Could not load this quiz. Check your connection and try again.",
    };
  }
}
