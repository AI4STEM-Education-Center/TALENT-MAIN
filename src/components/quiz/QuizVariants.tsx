"use client";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MathText } from "@/components/ui/math-text";
import type { VariantQuestion, Objective } from "@/lib/quiz-variants";

type SourceQuestion = {
  id: string;
  text: string;
  answerMode: string;
  feedbackGeneral?: string | null;
  options: {
    id?: string;
    text: string;
    isCorrect: boolean;
    imageUrl?: string | null;
  }[];
  answerTolerance?: number | null;
  answerNumeric?: number | null;
  answerUnit?: string | null;
  figureUrl?: string | null;
};
type Version = {
  id: string;
  name: string;
  variation: string;
  status: string;
  questions: VariantQuestion[];
  sourceSnapshot: VariantQuestion[];
  objectives: Objective[];
  error: string | null;
  aiModel: string | null;
  validation: { sourceQuestionId: string; explanation: string }[] | null;
};
async function request(url: string, method = "GET", body?: unknown) {
  const response = await fetch(url, {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Could not update alternative versions.");
  return data;
}

export function QuizVariants({
  quizId,
  questions,
}: {
  quizId: string;
  questions: SourceQuestion[];
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [objectives, setObjectives] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [page, setPage] = useState(0);
  const started = useRef(new Set<string>());
  const hydrated = useRef(false);
  const loaded = useRef(false);
  const [name, setName] = useState("Practice version");
  const [variation, setVariation] = useState("NUMBERS");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/quizzes/${quizId}/variants`;
  const refresh = useCallback(async () => {
    try {
      const data = (await request(url)).versions as Version[];
      setVersions(data);
      if (!hydrated.current) {
        hydrated.current = true;
        const restored = Object.fromEntries(
          (data[0]?.objectives ?? []).map((o) => [
            o.sourceQuestionId,
            o.objective,
          ]),
        );
        setObjectives(restored);
        setSaved(restored);
      }
      loaded.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load versions.");
    }
  }, [url]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const generating = versions.some(
    (v) => v.status === "QUEUED" || v.status === "GENERATING",
  );
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [generating, refresh]);
  async function change(body: unknown, method = "PATCH") {
    setBusy(true);
    setError("");
    try {
      await request(url, method, body);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update version.");
    } finally {
      setBusy(false);
    }
  }
  const supported =
    questions.length > 0 &&
    questions.length <= 40 &&
    questions.every(
      (q) =>
        ["SINGLE_SELECT", "NUMERIC"].includes(q.answerMode) &&
        !q.figureUrl &&
        !q.options.some((o) => o.imageUrl),
    );
  const objectiveList = (values: Record<string, string>) =>
    questions.map((q) => ({
      sourceQuestionId: q.id,
      objective:
        values[q.id]?.trim() ||
        "Preserve the original learning objective, reasoning steps, units, and difficulty.",
    }));
  const matches = versions.filter(
    (v) =>
      v.variation === variation &&
      objectiveList(saved).every((o) =>
        v.objectives.some(
          (vo) =>
            vo.sourceQuestionId === o.sourceQuestionId &&
            vo.objective === o.objective,
        ),
      ) &&
      v.sourceSnapshot.length === questions.length &&
      questions.every((q) =>
        v.sourceSnapshot.some(
          (source) =>
            source.id === q.id &&
            source.text === q.text &&
            JSON.stringify(source.options) ===
              JSON.stringify(
                q.options.map(({ id, text, isCorrect }) => ({
                  id,
                  text,
                  isCorrect,
                })),
              ) &&
            (source.answerTolerance ?? null) === (q.answerTolerance ?? null) &&
            (source.answerNumeric ?? null) === (q.answerNumeric ?? null) &&
            (source.answerUnit ?? null) === (q.answerUnit ?? null),
        ),
      ),
  );
  const ready = matches.filter(
    (v) => v.status === "REVIEW" || v.status === "PUBLISHED",
  );
  const visiblePage = Math.min(
    page,
    Math.max(0, Math.ceil(ready.length / 2) - 1),
  );
  const pair = ready.slice(visiblePage * 2, visiblePage * 2 + 2);
  async function generate(values: Record<string, string>, bothModes = false) {
    if (busy || generating || !supported) return;
    setBusy(true);
    setError("");
    try {
      await request(url, "POST", {
        name: name.trim() || "Practice version",
        variation,
        objectives: objectiveList(values),
        count: 4,
        bothModes,
      });
      setSaved(values);
      setPage(0);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate previews.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }
  const prepareMissingPreviews = useEffectEvent(() => {
    if (!loaded.current || !supported || busy || generating || matches.length)
      return;
    const key = JSON.stringify([variation, saved, questions]);
    if (started.current.has(key)) return;
    started.current.add(key);
    void generate(saved, !versions.length);
  });
  useEffect(() => {
    prepareMissingPreviews();
  }, [versions, questions, variation, saved, busy]);
  const invalidRestrictions = Object.values(objectives).some(
    (value) => value.trim().length > 0 && value.trim().length < 10,
  );
  return (
    <section
      className="rounded-xl border bg-card p-4 space-y-5"
      aria-label="Alternative quiz versions"
    >
      <div>
        <h2 className="text-lg font-semibold">Alternative practice versions</h2>
        <p className="text-sm text-muted-foreground">
          Compare the original with two alternatives. Four versions per change
          mode are prepared for you. Review answers before publishing; practice
          never changes grades.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!supported && (
        <p role="status">
          Previews support 1–40 text-only single-select or numeric questions.
        </p>
      )}
      <div className="flex flex-wrap items-end gap-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Allowed changes</legend>
          <div className="flex flex-wrap gap-2">
            {[
              ["NUMBERS", "Numbers & choices"],
              ["CONTEXT", "Context, numbers & choices"],
            ].map(([value, label]) => (
              <Button
                key={value}
                variant={variation === value ? "default" : "outline"}
                aria-pressed={variation === value}
                onClick={() => {
                  setVariation(value);
                  setPage(0);
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </fieldset>
        <label className="text-sm">
          Version name
          <Input
            value={name}
            maxLength={100}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/50 p-3">
        <p className="text-sm" role="status">
          {generating
            ? "Preparing and checking alternatives…"
            : `${ready.length} previews ready for this mode`}
        </p>
        <div className="flex gap-2">
          {ready.length > 2 && (
            <Button
              variant="outline"
              onClick={() =>
                setPage((p) => (p + 1) % Math.ceil(ready.length / 2))
              }
            >
              Show two more
            </Button>
          )}
          <Button
            variant="outline"
            disabled={busy || generating || !supported || invalidRestrictions}
            onClick={() => void generate(objectives)}
          >
            Generate four more
          </Button>
        </div>
      </div>
      {questions.map((q, index) => (
        <article key={q.id} className="overflow-hidden rounded-xl border">
          <h3 className="border-b bg-muted/40 px-4 py-3 font-semibold">
            Question {index + 1}
          </h3>
          <div className="grid divide-y lg:grid-cols-3 lg:divide-y-0 lg:divide-x">
            <QuestionPreview label="Original" question={q} />
            {[0, 1].map((slot) => (
              <QuestionPreview
                key={slot}
                label={pair[slot]?.name ?? `Alternative ${slot + 1}`}
                question={pair[slot]?.questions.find(
                  (v) => v.sourceQuestionId === q.id,
                )}
                pending={generating}
              />
            ))}
          </div>
          <div className="border-t bg-muted/20 p-4 space-y-2">
            <label
              htmlFor={`restrictions-${q.id}`}
              className="text-sm font-medium"
            >
              Learning objective & restrictions
            </label>
            <Textarea
              id={`restrictions-${q.id}`}
              rows={2}
              value={objectives[q.id] ?? ""}
              maxLength={2000}
              onChange={(e) =>
                setObjectives((prev) => ({ ...prev, [q.id]: e.target.value }))
              }
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  if (!invalidRestrictions) void generate(objectives);
                }
              }}
              placeholder="Keep the same skill and difficulty, or add restrictions such as whole-number answers only."
            />
            <div className="flex flex-wrap justify-between items-center gap-2">
              <p className="text-xs text-muted-foreground">
                Enter to save and preview · Shift+Enter for a new line. Optional
                restrictions need at least 10 characters.
              </p>
              <Button
                size="sm"
                disabled={
                  busy || generating || !supported || invalidRestrictions
                }
                onClick={() => void generate(objectives)}
              >
                Save & preview
              </Button>
            </div>
            {(objectives[q.id] ?? "") !== (saved[q.id] ?? "") && (
              <p className="text-xs text-amber-700">
                Unsaved restrictions — previews use the last saved settings.
              </p>
            )}
          </div>
        </article>
      ))}
      <details className="space-y-3">
        <summary className="cursor-pointer font-medium">
          Review & publish versions ({versions.length})
        </summary>
        {versions.map((version) => (
          <VariantReview
            key={`${version.id}:${version.status}`}
            version={version}
            busy={busy}
            change={change}
          />
        ))}
      </details>
    </section>
  );
}

function QuestionPreview({
  label,
  question,
  pending = false,
}: {
  label: string;
  question?: SourceQuestion;
  pending?: boolean;
}) {
  return (
    <div className="min-w-0 p-4 space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      {question ? (
        <>
          <MathText text={question.text} />
          <ul className="space-y-2">
            {question.options.map((option, i) => (
              <li
                key={option.id ?? option.text}
                className={`flex gap-2 rounded-lg border p-2 text-sm ${option.isCorrect ? "border-emerald-500/40 bg-emerald-500/10" : "bg-background"}`}
              >
                <span className="font-medium">
                  {String.fromCharCode(65 + i)}.
                </span>
                <MathText text={option.text} />
                {option.isCorrect && (
                  <span className="ml-auto text-xs font-medium">Correct</span>
                )}
              </li>
            ))}
          </ul>
          {question.answerMode === "NUMERIC" && (
            <p className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm">
              Answer: {question.answerNumeric} {question.answerUnit}
            </p>
          )}
        </>
      ) : (
        <div
          className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
          role="status"
        >
          {pending
            ? "Generating a checked preview…"
            : "No checked preview yet. Generate alternatives or review any failed versions below."}
        </div>
      )}
    </div>
  );
}

function VariantReview({
  version,
  busy,
  change,
}: {
  version: Version;
  busy: boolean;
  change: (body: unknown) => Promise<void>;
}) {
  const [edits, setEdits] = useState<VariantQuestion[] | null>(null);
  const draft = edits ?? version.questions;
  const [editing, setEditing] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  function update(id: string, patch: Partial<VariantQuestion>) {
    setEdits((prev) =>
      (prev ?? version.questions).map((q) =>
        q.id === id ? { ...q, ...patch } : q,
      ),
    );
  }
  return (
    <details className="rounded border p-3">
      <summary className="cursor-pointer font-medium">
        {version.name} · {version.status.toLowerCase()}
      </summary>
      <div className="mt-3 space-y-4">
        {version.error && (
          <p role="alert" className="text-sm text-destructive">
            {version.error}
          </p>
        )}
        {version.aiModel && (
          <p className="text-xs text-muted-foreground">
            Generated with {version.aiModel}. Automated checks do not replace
            your review.
          </p>
        )}
        {draft.map((q, i) => (
          <div key={q.id} className="border-t pt-3 space-y-3">
            <p className="text-sm font-medium">
              Question {i + 1} ·{" "}
              {
                version.objectives.find(
                  (o) => o.sourceQuestionId === q.sourceQuestionId,
                )?.objective
              }
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <p className="font-medium">Original</p>
                <QuestionPreview
                  label="Source question and choices"
                  question={version.sourceSnapshot.find(
                    (s) => s.id === q.sourceQuestionId,
                  )}
                />
              </div>
              <div className="space-y-2">
                <p className="font-medium">Alternative</p>
                {editing ? (
                  <label className="block text-sm">
                    Question text
                    <Textarea
                      value={q.text}
                      onChange={(e) => update(q.id, { text: e.target.value })}
                    />
                  </label>
                ) : (
                  <MathText text={q.text} />
                )}
                {q.options.map((option) => (
                  <div key={option.id} className="flex gap-2 items-center">
                    {editing ? (
                      <>
                        <input
                          type="radio"
                          aria-label={`Mark ${option.text} correct`}
                          name={`correct-${version.id}-${q.id}`}
                          checked={option.isCorrect}
                          onChange={() =>
                            update(q.id, {
                              options: q.options.map((o) => ({
                                ...o,
                                isCorrect: o.id === option.id,
                              })),
                            })
                          }
                        />
                        <Input
                          aria-label="Answer choice"
                          value={option.text}
                          onChange={(e) =>
                            update(q.id, {
                              options: q.options.map((o) =>
                                o.id === option.id
                                  ? { ...o, text: e.target.value }
                                  : o,
                              ),
                            })
                          }
                        />
                      </>
                    ) : (
                      <p>
                        {option.isCorrect ? "✓ " : ""}
                        <MathText text={option.text} />
                      </p>
                    )}
                  </div>
                ))}
                {q.answerMode === "NUMERIC" &&
                  (editing ? (
                    <div className="space-y-2">
                      <label className="block text-sm">
                        Correct number
                        <Input
                          type="number"
                          step="any"
                          value={q.answerNumeric ?? ""}
                          onChange={(e) =>
                            update(q.id, {
                              answerNumeric:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="block text-sm">
                        Absolute tolerance (blank uses default)
                        <Input
                          type="number"
                          step="any"
                          min="0"
                          value={q.answerTolerance ?? ""}
                          onChange={(e) =>
                            update(q.id, {
                              answerTolerance:
                                e.target.value === ""
                                  ? null
                                  : Number(e.target.value),
                            })
                          }
                        />
                      </label>
                      <label className="block text-sm">
                        Unit
                        <Input
                          value={q.answerUnit ?? ""}
                          onChange={(e) =>
                            update(q.id, { answerUnit: e.target.value || null })
                          }
                        />
                      </label>
                    </div>
                  ) : (
                    <p>
                      Answer: {q.answerNumeric} {q.answerUnit} · tolerance:{" "}
                      {q.answerTolerance ?? "default"}
                    </p>
                  ))}
              </div>
            </div>
            {editing ? (
              <label className="block text-sm">
                Worked solution
                <Textarea
                  value={q.solution}
                  onChange={(e) => update(q.id, { solution: e.target.value })}
                />
              </label>
            ) : (
              <div className="text-sm">
                <strong>Solution: </strong>
                <MathText text={q.solution} />
              </div>
            )}
            <p className="text-sm">Preserved intent: {q.intentExplanation}</p>
            <p className="text-sm text-muted-foreground">
              Independent check:{" "}
              {version.validation?.find(
                (r) => r.sourceQuestionId === q.sourceQuestionId,
              )?.explanation ?? "Pending"}
            </p>
          </div>
        ))}
        {(version.status === "REVIEW" ||
          (version.status === "FAILED" && draft.length > 0)) && (
          <div className="space-y-3">
            {editing ? (
              <Button
                disabled={busy}
                onClick={() =>
                  void change({
                    versionId: version.id,
                    action: "edit",
                    questions: draft,
                  })
                }
              >
                Save and revalidate
              </Button>
            ) : (
              <>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={reviewed}
                    onChange={(e) => setReviewed(e.target.checked)}
                  />
                  I reviewed every question, answer, and objective and approve
                  this version for practice.
                </label>
                <div className="flex gap-2">
                  <Button
                    disabled={busy || !reviewed || version.status !== "REVIEW"}
                    onClick={() =>
                      void change({ versionId: version.id, action: "publish" })
                    }
                  >
                    Publish for practice
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => setEditing(true)}
                  >
                    Edit questions
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
        {version.status === "FAILED" && (
          <Button
            disabled={busy}
            onClick={() =>
              void change({ versionId: version.id, action: "retry" })
            }
          >
            Retry generation / validation
          </Button>
        )}
        {version.status === "PUBLISHED" && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void change({ versionId: version.id, action: "retire" })
            }
          >
            Retire version
          </Button>
        )}
        {["QUEUED", "GENERATING"].includes(version.status) && (
          <p className="text-sm" role="status">
            Generating and checking this version. You can leave this page.
          </p>
        )}
      </div>
    </details>
  );
}
