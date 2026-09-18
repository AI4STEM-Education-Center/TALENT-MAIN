"use client";
import { useCallback, useEffect, useState } from "react";
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
};
type Version = {
  id: string;
  name: string;
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
  const [name, setName] = useState("Practice version");
  const [variation, setVariation] = useState("NUMBERS");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/quizzes/${quizId}/variants`;
  const refresh = useCallback(async () => {
    try {
      setVersions((await request(url)).versions);
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
  return (
    <section
      className="rounded-xl border p-4 space-y-4"
      aria-label="Alternative quiz versions"
    >
      <h2 className="text-lg font-semibold">Alternative practice versions</h2>
      <p className="text-sm text-muted-foreground">
        Create text-only single-select or numeric alternatives. Confirm what
        every question must assess, then review the generated answers before
        publishing. Practice never changes grades or uses graded attempts.
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <details>
        <summary className="cursor-pointer font-medium">
          Create a version
        </summary>
        <div className="space-y-3 mt-3">
          <label className="block text-sm">
            Version name
            <Input
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Allowed changes
            <select
              className="block border rounded p-2 w-full"
              value={variation}
              onChange={(e) => setVariation(e.target.value)}
            >
              <option value="NUMBERS">Numbers and answer choices</option>
              <option value="CONTEXT">
                Context, numbers, and answer choices
              </option>
            </select>
          </label>
          {questions.map((q, i) => (
            <div key={q.id} className="border rounded p-3 space-y-2">
              <p className="font-medium">Question {i + 1}</p>
              <MathText text={q.text} />
              <label className="block text-sm">
                Learning objective and constraints
                <Textarea
                  value={objectives[q.id] ?? ""}
                  maxLength={2000}
                  onChange={(e) =>
                    setObjectives((prev) => ({
                      ...prev,
                      [q.id]: e.target.value,
                    }))
                  }
                  placeholder="For example: calculate constant speed from distance and time; retain units, one-step reasoning, and whole-number answers."
                />
              </label>
            </div>
          ))}
          <Button
            disabled={
              busy ||
              generating ||
              !name.trim() ||
              !questions.length ||
              questions.some((q) => (objectives[q.id]?.trim().length ?? 0) < 10)
            }
            onClick={() =>
              void change(
                {
                  name,
                  variation,
                  objectives: questions.map((q) => ({
                    sourceQuestionId: q.id,
                    objective: objectives[q.id],
                  })),
                },
                "POST",
              )
            }
          >
            Confirm objectives and generate
          </Button>
        </div>
      </details>
      {!versions.length && (
        <p className="text-sm text-muted-foreground">
          No alternative versions yet.
        </p>
      )}
      {versions.map((version) => (
        <VariantReview
          key={`${version.id}:${version.status}`}
          version={version}
          busy={busy}
          change={change}
        />
      ))}
    </section>
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
                <MathText
                  text={
                    version.sourceSnapshot.find(
                      (s) => s.id === q.sourceQuestionId,
                    )?.text ?? ""
                  }
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
