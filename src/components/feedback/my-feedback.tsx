"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** One verdict the signed-in person has already left. */
export type MyFeedbackEntry = { rating: number; comment: string };

type MyFeedbackStore = {
  loading: boolean;
  /** The caller's existing verdict on a subject, by feedbackSubjectKey(). */
  get: (subjectKey: string) => MyFeedbackEntry | undefined;
  /** Cache a just-saved verdict so the form reopens pre-filled. */
  record: (subjectKey: string, entry: MyFeedbackEntry) => void;
};

/**
 * Inert store used when a rating form renders outside a provider: the form
 * still submits, it just cannot pre-fill. Kept as a module constant so it is
 * referentially stable and never re-renders a consumer.
 */
const NO_STORE: MyFeedbackStore = {
  loading: false,
  get: () => undefined,
  record: () => {},
};

const MyFeedbackContext = createContext<MyFeedbackStore | null>(null);

type ApiRow = { subjectKey: string; rating: number; comment: string };

/**
 * Fetches the signed-in person's own feedback ONCE for a surface and shares it
 * with every rating form under it.
 *
 * Submissions upsert (one verdict per author per subject), so a form that
 * always opened blank would invite someone to overwrite a considered answer
 * with an accidental one. Doing the lookup here rather than in each form
 * matters on the results page, where three material cards and a simulation
 * rail would otherwise fire four identical requests.
 *
 * Pass `attemptId` on the post-quiz results page, or `simulationId` for a
 * single simulation (the teacher/admin panel).
 */
export function MyFeedbackProvider({
  attemptId,
  simulationId,
  children,
}: {
  attemptId?: string;
  simulationId?: string;
  children: ReactNode;
}) {
  const [entries, setEntries] = useState<Map<string, MyFeedbackEntry>>(
    () => new Map(),
  );
  const [loading, setLoading] = useState(true);

  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect -- every post-await write is guarded by `signal.aborted`, and the effect aborts on cleanup
  useEffect(() => {
    if (!attemptId && !simulationId) {
      setLoading(false);
      return;
    }
    const abort = new AbortController();
    const query = new URLSearchParams(
      attemptId ? { attemptId } : { simulationId: simulationId! },
    );

    (async () => {
      try {
        const res = await fetch(`/api/feedback/mine?${query}`, {
          signal: abort.signal,
        });
        if (!res.ok) return;
        const data: { feedback?: ApiRow[] } = await res.json();
        // The signal cancels the fetch, but not a body already being read, so
        // re-check it before touching state: unmounting mid-parse must not
        // resurrect a provider that is gone.
        if (abort.signal.aborted) return;
        setEntries(
          new Map(
            (data.feedback ?? []).map((row) => [
              row.subjectKey,
              { rating: row.rating, comment: row.comment },
            ]),
          ),
        );
      } catch {
        // A failed lookup only costs the pre-fill; the forms still work.
      } finally {
        if (!abort.signal.aborted) setLoading(false);
      }
    })();

    return () => abort.abort();
  }, [attemptId, simulationId]);

  const record = useCallback((subjectKey: string, entry: MyFeedbackEntry) => {
    setEntries((prev) => new Map(prev).set(subjectKey, entry));
  }, []);

  const store = useMemo<MyFeedbackStore>(
    () => ({ loading, get: (key) => entries.get(key), record }),
    [loading, entries, record],
  );

  return (
    <MyFeedbackContext.Provider value={store}>
      {children}
    </MyFeedbackContext.Provider>
  );
}

export function useMyFeedback(): MyFeedbackStore {
  return useContext(MyFeedbackContext) ?? NO_STORE;
}
