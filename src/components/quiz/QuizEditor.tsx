"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MathText } from "@/components/ui/math-text";
import { parseQtiQuestionBank } from "@/lib/question-import/qti";
import { normalizeNumericValue } from "@/lib/quiz-scoring";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { QuizPdfImport } from "@/components/quiz/QuizPdfImport";
import { SimulationStatusBadge } from "@/components/simulation/SimulationStatusBadge";
import { SimulationPanel } from "@/components/simulation/SimulationPanel";
import { Plus, Pencil, Trash2, Check, X, ArrowLeft, FileQuestion, Upload, Download, Atom } from "lucide-react";

type AnswerMode = "SINGLE_SELECT" | "MULTI_SELECT" | "NUMERIC";
interface Option { id?: string; text: string; isCorrect: boolean; imageUrl?: string | null; imageAlt?: string | null }
interface QuestionSimulation {
  id: string;
  status: string;
  title: string | null;
  hasContent: boolean;
}
interface Question {
  id: string;
  title?: string | null;
  text: string;
  difficultyLevel: string;
  answerMode: AnswerMode;
  points?: number | null;
  feedbackGeneral?: string | null;
  sourceQuestionId?: string | null;
  simulation?: QuestionSimulation | null;
  options: Option[];
  // NUMERIC questions only.
  answerNumeric?: number | null;
  answerTolerance?: number | null;
  answerUnit?: string | null;
  // Presigned transient figure URL (from attachFigureUrls); never the raw key.
  figureUrl?: string | null;
  figureAlt?: string | null;
}
interface Topic { id: string; name: string }
interface QuizDetail {
  id: string;
  name: string;
  topicId: string | null;
  topic: Topic | null;
  teacherId: string | null;
  questions: Question[];
  editable: boolean;
}
interface ImportSummary { importedCount: number; skippedCount: number; errorCount: number; bankTitle?: string; errors?: { index: number; sourceQuestionId?: string; message: string }[] }

const emptyOptions = () => [{ id: crypto.randomUUID(), text: "", isCorrect: false }, { id: crypto.randomUUID(), text: "", isCorrect: false }, { id: crypto.randomUUID(), text: "", isCorrect: false }, { id: crypto.randomUUID(), text: "", isCorrect: false }];

/**
 * Full quiz editor: rename/regroup the quiz, add/edit/delete questions, import
 * a QTI ZIP into it. Renders read-only (with an optional "import a copy"
 * action) when the caller can't manage the quiz — e.g. a teacher previewing a
 * global-pool quiz.
 */
export function QuizEditor({ quizId, backHref, backLabel }: { quizId: string; backHref: string; backLabel: string }) {
  const confirm = useConfirm();
  const router = useRouter();

  const [quiz, setQuiz] = useState<QuizDetail | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [form, setForm] = useState({
    text: "",
    difficultyLevel: "BEGINNER",
    answerMode: "SINGLE_SELECT" as AnswerMode,
    options: emptyOptions(),
    // NUMERIC fields are held as raw input strings; parsed/validated on save.
    answerNumeric: "",
    answerTolerance: "",
    answerUnit: "",
  });
  const [importSourcePath, setImportSourcePath] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [poolImportBusy, setPoolImportBusy] = useState(false);
  // True while a PDF import is in progress; hides the QTI card to free up space.
  const [pdfImportActive, setPdfImportActive] = useState(false);
  // Simulation being viewed/reviewed in the dialog, if any.
  const [openSimulationId, setOpenSimulationId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`/api/quizzes/${quizId}`).then((r) => (r.ok ? r.json() : null)),
      fetch("/api/topics").then((r) => r.json()),
    ]).then(([q, ts]) => {
      if (!q) setNotFound(true);
      else setQuiz(q);
      setTopics(ts);
      setLoading(false);
    });
  }, [quizId]);

  async function refreshQuestions() {
    const q = await fetch(`/api/quizzes/${quizId}`).then((r) => r.json());
    setQuiz(q);
  }

  async function saveName() {
    if (!nameDraft.trim() || !quiz) return;
    const res = await fetch(`/api/quizzes/${quizId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: nameDraft.trim() }),
    });
    if (res.ok) {
      setQuiz({ ...quiz, name: nameDraft.trim() });
      setEditingName(false);
    }
  }

  async function changeTopic(topicId: string) {
    if (!quiz) return;
    const res = await fetch(`/api/quizzes/${quizId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId: topicId || null }),
    });
    if (res.ok) {
      const updated = await res.json();
      setQuiz({ ...quiz, topicId: updated.topicId, topic: updated.topic });
    }
  }

  // Teacher previewing a pool quiz: pull an independent copy into their own list.
  async function importPoolCopy() {
    setPoolImportBusy(true);
    try {
      const res = await fetch(`/api/quizzes/pool/${quizId}/import`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error ?? "Import failed."); return; }
      router.push(`/teacher/quizzes/${data.id}`);
    } finally {
      setPoolImportBusy(false);
    }
  }

  function startEdit(q: Question) {
    setEditingQuestion(q);
    setForm({
      text: q.text,
      difficultyLevel: q.difficultyLevel,
      answerMode: q.answerMode ?? "SINGLE_SELECT",
      // Keep choice options even for a NUMERIC question (usually empty), so a
      // teacher who switches the type back doesn't lose any prior options.
      options: q.options.length > 0
        ? q.options.map((o) => ({ id: o.id ?? crypto.randomUUID(), text: o.text, isCorrect: o.isCorrect }))
        : emptyOptions(),
      answerNumeric: q.answerNumeric != null ? String(q.answerNumeric) : "",
      answerTolerance: q.answerTolerance != null ? String(q.answerTolerance) : "",
      answerUnit: q.answerUnit ?? "",
    });
    setShowForm(true);
  }

  function resetForm() {
    setForm({ text: "", difficultyLevel: "BEGINNER", answerMode: "SINGLE_SELECT", options: emptyOptions(), answerNumeric: "", answerTolerance: "", answerUnit: "" });
    setEditingQuestion(null);
    setShowForm(false);
  }

  function setOption(index: number, field: "text" | "isCorrect", value: string | boolean) {
    setForm((prev) => ({ ...prev, options: prev.options.map((o, i) => i === index ? { ...o, [field]: value } : o) }));
  }

  // Generate the new option's id at event time, not during render, so no random
  // value is reached from JSX (which would risk a server/client hydration drift).
  function addOption() {
    setForm((prev) => ({ ...prev, options: [...prev.options, { id: crypto.randomUUID(), text: "", isCorrect: false }] }));
  }

  function markCorrect(index: number) {
    setForm((prev) => ({
      ...prev,
      options: prev.options.map((o, i) => ({
        ...o,
        isCorrect: prev.answerMode === "MULTI_SELECT" ? (i === index ? !o.isCorrect : o.isCorrect) : i === index,
      })),
    }));
  }

  function setAnswerMode(answerMode: AnswerMode) {
    setForm((prev) => ({
      ...prev,
      answerMode,
      options: answerMode === "SINGLE_SELECT"
        ? prev.options.map((option, index) => ({ ...option, isCorrect: index === prev.options.findIndex((o) => o.isCorrect) }))
        : prev.options,
    }));
  }

  async function saveQuestion() {
    if (!form.text.trim()) { setMsg("Fill in the question text."); return; }

    const isNumeric = form.answerMode === "NUMERIC";
    let body: Record<string, unknown>;

    if (isNumeric) {
      // Client validation mirrors the API: a finite answer is required, and a
      // tolerance — if given — must be > 0.
      const answerNumeric = normalizeNumericValue(form.answerNumeric);
      if (answerNumeric === null) { setMsg("Enter a valid numeric answer."); return; }
      let answerTolerance: number | null = null;
      if (form.answerTolerance.trim()) {
        const tol = normalizeNumericValue(form.answerTolerance);
        if (tol === null || tol <= 0) { setMsg("Tolerance must be a positive number."); return; }
        answerTolerance = tol;
      }
      const answerUnit = form.answerUnit.trim() || null;
      const numericFields = { answerMode: "NUMERIC", answerNumeric, answerTolerance, answerUnit, options: [] as Option[] };
      body = editingQuestion
        ? { id: editingQuestion.id, text: form.text, difficultyLevel: form.difficultyLevel, ...numericFields }
        : { text: form.text, difficultyLevel: form.difficultyLevel, quizId, ...numericFields };
    } else {
      const validOptions = form.options.filter((o) => o.text.trim());
      if (validOptions.length < 2) { setMsg("Add at least 2 options."); return; }
      if (!validOptions.some((o) => o.isCorrect)) { setMsg("Mark one option as correct."); return; }
      body = editingQuestion
        ? { id: editingQuestion.id, text: form.text, difficultyLevel: form.difficultyLevel, answerMode: form.answerMode, options: validOptions }
        : { text: form.text, difficultyLevel: form.difficultyLevel, answerMode: form.answerMode, quizId, options: validOptions };
    }

    const method = editingQuestion ? "PATCH" : "POST";
    const res = await fetch("/api/questions", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      setMsg(editingQuestion ? "Question updated." : "Question created.");
      resetForm();
      await refreshQuestions();
    }
  }

  async function deleteQuestion(id: string) {
    const ok = await confirm({
      title: "Delete this question?",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    await fetch("/api/questions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setQuiz((prev) => prev ? { ...prev, questions: prev.questions.filter((q) => q.id !== id) } : prev);
  }

  async function importQuestions() {
    setMsg("");
    setImportSummary(null);
    if (!importFile) {
      setMsg("Choose a QTI ZIP file to import.");
      return;
    }
    if (!importFile.name.toLowerCase().endsWith(".zip")) {
      setMsg("Only QTI .zip files are supported.");
      return;
    }

    setImportBusy(true);
    try {
      const zip = await JSZip.loadAsync(importFile);
      const qtiXml = zip.file("qti/qti.xml");
      if (!qtiXml) {
        setMsg("The QTI ZIP must contain qti/qti.xml.");
        return;
      }

      const parsed = parseQtiQuestionBank(await qtiXml.async("text"));
      if (parsed.questions.length === 0 && parsed.errors.length === 0) {
        setMsg("No questions were found in qti/qti.xml.");
        return;
      }

      const res = await fetch("/api/question-imports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quizId,
          originalName: importFile.name,
          sourcePath: importSourcePath.trim() || undefined,
          ...parsed,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsg(data.error ?? "Import failed.");
        return;
      }

      setImportSummary(data);
      setMsg(`Imported ${data.importedCount} question${data.importedCount === 1 ? "" : "s"}. Skipped ${data.skippedCount}.`);
      setImportFile(null);
      await refreshQuestions();
    } catch (error) {
      setMsg(error instanceof Error ? error.message : "Import failed.");
    } finally {
      setImportBusy(false);
    }
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (notFound || !quiz) return <div className="p-6 text-muted-foreground">Quiz not found.</div>;

  const readOnly = !quiz.editable;
  const isPoolQuiz = quiz.teacherId === null;

  return (
    <div className="max-w-6xl p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={backHref}><ArrowLeft className="size-4" /> {backLabel}</Link>
      </Button>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          {editingName ? (
            <div className="flex items-center gap-2">
              <Input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveName()} className="h-9 text-lg font-bold" autoFocus />
              <Button size="sm" variant="ghost" onClick={saveName}><Check className="size-3" /></Button>
              <Button size="sm" variant="ghost" onClick={() => setEditingName(false)}><X className="size-3" /></Button>
            </div>
          ) : (
            <h1 className="text-3xl font-bold flex items-center gap-2">
              {quiz.name}
              {!readOnly && (
                <Button size="sm" variant="ghost" onClick={() => { setNameDraft(quiz.name); setEditingName(true); }} aria-label="Rename quiz">
                  <Pencil className="size-3" />
                </Button>
              )}
            </h1>
          )}
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {isPoolQuiz && <Badge variant="secondary">Global pool</Badge>}
            <Badge variant="outline">{quiz.questions.length} question{quiz.questions.length !== 1 ? "s" : ""}</Badge>
            {readOnly ? (
              quiz.topic && <Badge variant="outline">{quiz.topic.name}</Badge>
            ) : (
              <select
                className="flex h-8 rounded-md border border-input bg-background px-2 text-sm"
                value={quiz.topicId ?? ""}
                onChange={(e) => changeTopic(e.target.value)}
                aria-label="Topic"
              >
                <option value="">No topic</option>
                {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
          </div>
        </div>
        <div className="flex gap-2 shrink-0">
          {readOnly ? (
            <Button onClick={importPoolCopy} disabled={poolImportBusy}>
              <Download className="size-4" /> {poolImportBusy ? "Importing…" : "Import to my quizzes"}
            </Button>
          ) : (
            <Button onClick={() => { resetForm(); setShowForm(true); }}>
              <Plus className="size-4" /> Add Question
            </Button>
          )}
        </div>
      </div>

      {msg && <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>}

      {!readOnly && !pdfImportActive && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Upload className="size-5" /> Import from QTI ZIP</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Upload a QTI ZIP question bank into this quiz. The ZIP is opened in your browser, and only parsed questions are sent to the server.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>QTI ZIP File</Label>
                <Input type="file" accept=".zip,application/zip" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} />
              </div>
              <div className="space-y-2">
                <Label>Source folder/path (optional)</Label>
                <Input value={importSourcePath} onChange={(e) => setImportSourcePath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !importBusy && importFile) importQuestions(); }} placeholder="e.g. data/3_Forces/PHY1-F-IFBDF-091725" />
              </div>
            </div>
            <Button onClick={importQuestions} disabled={importBusy || !importFile}>
              {importBusy ? "Importing..." : "Import QTI ZIP"}
            </Button>
            {importSummary && (
              <div className="rounded-md border p-3 text-sm space-y-2">
                <p className="font-medium">{importSummary.bankTitle ?? "Question bank"} import complete</p>
                <p className="text-muted-foreground">
                  Imported {importSummary.importedCount}, skipped {importSummary.skippedCount}, validation errors {importSummary.errorCount}.
                </p>
                {importSummary.errors && importSummary.errors.length > 0 && (
                  <div className="space-y-1 text-destructive">
                    {importSummary.errors.slice(0, 5).map((error) => (
                      <p key={`${error.index}-${error.sourceQuestionId ?? "unknown"}`}>Question {error.sourceQuestionId ?? error.index + 1}: {error.message}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!readOnly && <QuizPdfImport quizId={quiz.id} onCommitted={refreshQuestions} onActiveChange={setPdfImportActive} />}

      {/* Form */}
      {showForm && !readOnly && (
        <Card>
          <CardHeader>
            <CardTitle>{editingQuestion ? "Edit Question" : "New Question"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Difficulty</Label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.difficultyLevel} onChange={(e) => setForm((p) => ({ ...p, difficultyLevel: e.target.value }))}>
                <option value="BEGINNER">Beginner</option>
                <option value="INTERMEDIATE">Intermediate</option>
                <option value="ADVANCED">Advanced</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Answer Type</Label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.answerMode} onChange={(e) => setAnswerMode(e.target.value as AnswerMode)}>
                <option value="SINGLE_SELECT">Single correct answer</option>
                <option value="MULTI_SELECT">Select all that apply</option>
                <option value="NUMERIC">Numeric answer</option>
              </select>
            </div>
            <div className="space-y-2">
              <Label>Question Text</Label>
              <Textarea value={form.text} onChange={(e) => setForm((p) => ({ ...p, text: e.target.value }))} rows={3} placeholder="Enter the question..." />
            </div>
            {form.answerMode === "NUMERIC" ? (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Correct answer</Label>
                  <Input inputMode="decimal" value={form.answerNumeric} onChange={(e) => setForm((p) => ({ ...p, answerNumeric: e.target.value }))} placeholder="e.g. 9.81" />
                </div>
                <div className="space-y-2">
                  <Label>Tolerance ±</Label>
                  <Input inputMode="decimal" value={form.answerTolerance} onChange={(e) => setForm((p) => ({ ...p, answerTolerance: e.target.value }))} placeholder="auto (±0.5%, min 0.01)" />
                </div>
                <div className="space-y-2">
                  <Label>Unit</Label>
                  <Input value={form.answerUnit} onChange={(e) => setForm((p) => ({ ...p, answerUnit: e.target.value }))} placeholder="display only, supports $LaTeX$" />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <Label>Options <span className="text-muted-foreground text-xs">({form.answerMode === "MULTI_SELECT" ? "click boxes to mark all correct answers" : "click radio to mark correct"})</span></Label>
                {form.options.map((opt, i) => (
                  <div key={opt.id ?? i} className="flex items-center gap-2">
                    <button type="button" aria-label={opt.isCorrect ? "Mark as incorrect" : "Mark as correct"} onClick={() => markCorrect(i)} className={`size-4 border-2 shrink-0 ${form.answerMode === "MULTI_SELECT" ? "rounded" : "rounded-full"} ${opt.isCorrect ? "bg-green-500 border-green-500" : "border-muted-foreground"}`} />
                    <Input placeholder={`Option ${i + 1}`} value={opt.text} onChange={(e) => setOption(i, "text", e.target.value)} />
                  </div>
                ))}
                <Button variant="ghost" size="sm" onClick={addOption}>
                  <Plus className="size-3" /> Add option
                </Button>
              </div>
            )}
            <div className="flex gap-3">
              <Button onClick={saveQuestion}><Check className="size-4" /> {editingQuestion ? "Update" : "Save"}</Button>
              <Button variant="outline" onClick={resetForm}><X className="size-4" /> Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Questions List */}
      {quiz.questions.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 text-muted-foreground">
            <FileQuestion className="size-10 mx-auto mb-3" />
            <p>{readOnly ? "This quiz has no questions." : "No questions yet. Add one above."}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {quiz.questions.map((q, i) => (
            <Card key={q.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground font-mono">Q{i + 1}</span>
                      <Badge variant="outline" className="text-xs">{q.difficultyLevel}</Badge>
                      <Badge variant="outline" className="text-xs">{q.answerMode === "NUMERIC" ? "Numeric" : q.answerMode === "MULTI_SELECT" ? "Multi-select" : "Single-select"}</Badge>
                      {q.sourceQuestionId && <Badge variant="secondary" className="text-xs">{q.sourceQuestionId}</Badge>}
                      {q.simulation && <SimulationStatusBadge status={q.simulation.status} />}
                    </div>
                    {q.title && <p className="text-sm font-semibold">{q.title}</p>}
                    <p className="font-medium"><MathText text={q.text} /></p>
                    {q.figureUrl && (
                      // Plain <img>: the src is a short-lived presigned S3 URL, not a
                      // static asset, so next/image can't optimize it. Mirrors
                      // QuizReviewResult's presigned-image img.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={q.figureUrl} className="max-h-24 rounded border" alt={q.figureAlt ?? "Question figure"} />
                    )}
                    {q.answerMode === "NUMERIC" ? (
                      <div className="text-sm text-green-700 font-medium space-y-1">
                        {q.answerNumeric != null && <p>Answer: {q.answerNumeric}{q.answerUnit ? " " : ""}{q.answerUnit ? <MathText text={q.answerUnit} /> : null}</p>}
                        {q.answerTolerance != null && <p className="text-muted-foreground">± {q.answerTolerance}</p>}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {q.options.map((opt) => (
                          <div key={opt.id} className={`text-sm flex items-center gap-2 ${opt.isCorrect ? "text-green-700 font-medium" : "text-muted-foreground"}`}>
                            <span className={`size-3 rounded-full shrink-0 ${opt.isCorrect ? "bg-green-500" : "bg-muted-foreground/30"}`} />
                            {opt.imageUrl ? (
                              // Plain <img>: short-lived presigned S3 URL (see figure img above).
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={opt.imageUrl} alt={opt.imageAlt ?? "Answer choice"} className="max-h-20 rounded border bg-white" />
                            ) : (
                              <MathText text={opt.text} />
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {(q.points || q.feedbackGeneral) && (
                      <div className="text-xs text-muted-foreground space-y-1">
                        {q.points ? <p>Points: {q.points}</p> : null}
                        {q.feedbackGeneral ? <p>Feedback: {q.feedbackGeneral}</p> : null}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {q.simulation && (q.simulation.hasContent || q.simulation.status === "DECLINED") && (
                      <Button size="sm" variant="ghost" onClick={() => setOpenSimulationId(q.simulation!.id)}>
                        <Atom className="size-3" /> Simulation
                      </Button>
                    )}
                    {!readOnly && (
                      <>
                        <Button size="sm" variant="ghost" onClick={() => startEdit(q)}><Pencil className="size-3" /></Button>
                        <Button size="sm" variant="ghost" onClick={() => deleteQuestion(q.id)}><Trash2 className="size-3 text-destructive" /></Button>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Simulation viewer + feedback loop. Refresh on close so a feedback
          round's REVISING (or a finished revision's READY) badge shows. */}
      {openSimulationId && (
        <SimulationPanel
          simulationId={openSimulationId}
          canGiveFeedback={!readOnly}
          open
          onOpenChange={(open) => {
            if (!open) {
              setOpenSimulationId(null);
              refreshQuestions();
            }
          }}
        />
      )}
    </div>
  );
}
