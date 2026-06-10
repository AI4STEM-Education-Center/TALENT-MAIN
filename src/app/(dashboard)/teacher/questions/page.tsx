"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import JSZip from "jszip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { parseQtiQuestionBank } from "@/lib/question-import/qti";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Plus, Pencil, Trash2, Check, X, ArrowLeft, FileQuestion, Upload } from "lucide-react";

type AnswerMode = "SINGLE_SELECT" | "MULTI_SELECT";
interface Option { id?: string; text: string; isCorrect: boolean }
interface Question {
  id: string;
  title?: string | null;
  text: string;
  difficultyLevel: string;
  answerMode: AnswerMode;
  points?: number | null;
  feedbackGeneral?: string | null;
  feedbackCorrect?: string | null;
  feedbackIncorrect?: string | null;
  sourceQuestionId?: string | null;
  subtopicId: string;
  topicId: string;
  options: Option[];
  subtopic: { name: string };
  topic: { name: string };
}
interface Subtopic { id: string; name: string }
interface Topic { id: string; name: string; subtopics: Subtopic[] }
interface ImportSummary { importedCount: number; skippedCount: number; errorCount: number; bankTitle?: string; errors?: { index: number; sourceQuestionId?: string; message: string }[] }

const emptyOptions = () => [{ id: crypto.randomUUID(), text: "", isCorrect: false }, { id: crypto.randomUUID(), text: "", isCorrect: false }, { id: crypto.randomUUID(), text: "", isCorrect: false }, { id: crypto.randomUUID(), text: "", isCorrect: false }];

function QuestionsContent() {
  const confirm = useConfirm();
  const searchParams = useSearchParams();
  const filterSubtopicId = searchParams.get("subtopicId") || "";
  const filterTopicId = searchParams.get("topicId") || "";

  const [questions, setQuestions] = useState<Question[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [form, setForm] = useState({ text: "", topicId: filterTopicId, subtopicId: filterSubtopicId, difficultyLevel: "BEGINNER", answerMode: "SINGLE_SELECT" as AnswerMode, options: emptyOptions() });
  const [importTopicId, setImportTopicId] = useState(filterTopicId);
  const [importSubtopicId, setImportSubtopicId] = useState(filterSubtopicId);
  const [importSourcePath, setImportSourcePath] = useState("");
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importSummary, setImportSummary] = useState<ImportSummary | null>(null);
  const [msg, setMsg] = useState("");

  const subtopicsForTopic = topics.find((t) => t.id === form.topicId)?.subtopics || [];
  const subtopicsForImport = topics.find((t) => t.id === importTopicId)?.subtopics || [];

  useEffect(() => {
    const params = new URLSearchParams();
    if (filterTopicId) params.set("topicId", filterTopicId);
    if (filterSubtopicId) params.set("subtopicId", filterSubtopicId);

    Promise.all([
      fetch(`/api/questions?${params}`).then((r) => r.json()),
      fetch("/api/topics").then((r) => r.json()),
    ]).then(([qs, ts]) => { setQuestions(qs); setTopics(ts); setLoading(false); });
  }, [filterTopicId, filterSubtopicId]);

  async function refreshQuestions() {
    const params = new URLSearchParams();
    if (filterTopicId) params.set("topicId", filterTopicId);
    if (filterSubtopicId) params.set("subtopicId", filterSubtopicId);
    const qs = await fetch(`/api/questions?${params}`).then((r) => r.json());
    setQuestions(qs);
  }

  function startEdit(q: Question) {
    setEditingQuestion(q);
    setForm({ text: q.text, topicId: q.topicId, subtopicId: q.subtopicId, difficultyLevel: q.difficultyLevel, answerMode: q.answerMode ?? "SINGLE_SELECT", options: q.options.map((o) => ({ id: o.id ?? crypto.randomUUID(), text: o.text, isCorrect: o.isCorrect })) });
    setShowForm(true);
  }

  function resetForm() {
    setForm({ text: "", topicId: filterTopicId, subtopicId: filterSubtopicId, difficultyLevel: "BEGINNER", answerMode: "SINGLE_SELECT", options: emptyOptions() });
    setEditingQuestion(null);
    setShowForm(false);
  }

  function setOption(index: number, field: "text" | "isCorrect", value: string | boolean) {
    setForm((prev) => ({ ...prev, options: prev.options.map((o, i) => i === index ? { ...o, [field]: value } : o) }));
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
    const validOptions = form.options.filter((o) => o.text.trim());
    if (!form.text.trim() || !form.topicId || !form.subtopicId) { setMsg("Fill in question text, topic and module."); return; }
    if (validOptions.length < 2) { setMsg("Add at least 2 options."); return; }
    if (!validOptions.some((o) => o.isCorrect)) { setMsg("Mark one option as correct."); return; }

    const method = editingQuestion ? "PATCH" : "POST";
    const body = editingQuestion ? { id: editingQuestion.id, text: form.text, difficultyLevel: form.difficultyLevel, answerMode: form.answerMode, options: validOptions } : { ...form, options: validOptions };

    const res = await fetch("/api/questions", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      const q = await res.json();
      if (editingQuestion) {
        setQuestions((prev) => prev.map((x) => x.id === q.id ? { ...x, ...q } : x));
        setMsg("Question updated.");
      } else {
        setQuestions((prev) => [...prev, q]);
        setMsg("Question created.");
      }
      resetForm();
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
    setQuestions((prev) => prev.filter((q) => q.id !== id));
  }

  async function importQuestions() {
    setMsg("");
    setImportSummary(null);
    if (!importTopicId || !importSubtopicId || !importFile) {
      setMsg("Choose a topic, module, and QTI ZIP file to import.");
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
          topicId: importTopicId,
          subtopicId: importSubtopicId,
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

  const subtopicName = filterSubtopicId ? questions[0]?.subtopic?.name : null;
  const topicName = filterTopicId ? questions[0]?.topic?.name : null;

  return (
    <div className="p-4 md:p-6 space-y-6">
      {filterTopicId && (
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/teacher/topics/${filterTopicId}`}><ArrowLeft className="size-4" /> Back to modules</Link>
        </Button>
      )}

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold">Question Bank</h1>
          {subtopicName && topicName && <p className="text-muted-foreground text-sm mt-1">Filtered: {topicName} › {subtopicName}</p>}
        </div>
        <Button className="shrink-0" onClick={() => { resetForm(); setShowForm(true); }}>
          <Plus className="size-4" /> Add Question
        </Button>
      </div>

      {msg && <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Upload className="size-5" /> Import Questions</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Upload a QTI ZIP question bank into a topic module. The ZIP is opened in your browser, and only parsed questions are sent to the server.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Topic</Label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={importTopicId} onChange={(e) => { setImportTopicId(e.target.value); setImportSubtopicId(""); }}>
                <option value="">Select topic</option>
                {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="space-y-2">
              <Label>Module</Label>
              <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={importSubtopicId} onChange={(e) => setImportSubtopicId(e.target.value)} disabled={!importTopicId}>
                <option value="">Select module</option>
                {subtopicsForImport.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>QTI ZIP File</Label>
              <Input type="file" accept=".zip,application/zip" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} />
            </div>
            <div className="space-y-2">
              <Label>Source folder/path (optional)</Label>
              <Input value={importSourcePath} onChange={(e) => setImportSourcePath(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !importBusy && importTopicId && importSubtopicId && importFile) importQuestions(); }} placeholder="e.g. data/3_Forces/PHY1-F-IFBDF-091725" />
            </div>
          </div>
          <Button onClick={importQuestions} disabled={importBusy || !importTopicId || !importSubtopicId || !importFile}>
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

      {/* Form */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>{editingQuestion ? "Edit Question" : "New Question"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Topic</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.topicId} onChange={(e) => setForm((p) => ({ ...p, topicId: e.target.value, subtopicId: "" }))}>
                  <option value="">Select topic</option>
                  {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Module</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={form.subtopicId} onChange={(e) => setForm((p) => ({ ...p, subtopicId: e.target.value }))} disabled={!form.topicId}>
                  <option value="">Select module</option>
                  {subtopicsForTopic.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
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
              </select>
            </div>
            <div className="space-y-2">
              <Label>Question Text</Label>
              <Textarea value={form.text} onChange={(e) => setForm((p) => ({ ...p, text: e.target.value }))} rows={3} placeholder="Enter the question..." />
            </div>
            <div className="space-y-2">
              <Label>Options <span className="text-muted-foreground text-xs">({form.answerMode === "MULTI_SELECT" ? "click boxes to mark all correct answers" : "click radio to mark correct"})</span></Label>
              {form.options.map((opt, i) => (
                <div key={opt.id ?? i} className="flex items-center gap-2">
                  <button type="button" aria-label={opt.isCorrect ? "Mark as incorrect" : "Mark as correct"} onClick={() => markCorrect(i)} className={`size-4 border-2 shrink-0 ${form.answerMode === "MULTI_SELECT" ? "rounded" : "rounded-full"} ${opt.isCorrect ? "bg-green-500 border-green-500" : "border-muted-foreground"}`} />
                  <Input placeholder={`Option ${i + 1}`} value={opt.text} onChange={(e) => setOption(i, "text", e.target.value)} />
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setForm((p) => ({ ...p, options: [...p.options, { id: crypto.randomUUID(), text: "", isCorrect: false }] }))}>
                <Plus className="size-3" /> Add option
              </Button>
            </div>
            <div className="flex gap-3">
              <Button onClick={saveQuestion}><Check className="size-4" /> {editingQuestion ? "Update" : "Save"}</Button>
              <Button variant="outline" onClick={resetForm}><X className="size-4" /> Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Questions List */}
      {questions.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 text-muted-foreground">
            <FileQuestion className="size-10 mx-auto mb-3" />
            <p>No questions yet. Add one above.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {questions.map((q, i) => (
            <Card key={q.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground font-mono">Q{i + 1}</span>
                      <Badge variant="outline" className="text-xs">{q.difficultyLevel}</Badge>
                      <Badge variant="outline" className="text-xs">{q.answerMode === "MULTI_SELECT" ? "Multi-select" : "Single-select"}</Badge>
                      <Badge variant="secondary" className="text-xs">{q.subtopic?.name}</Badge>
                      {q.sourceQuestionId && <Badge variant="secondary" className="text-xs">{q.sourceQuestionId}</Badge>}
                    </div>
                    {q.title && <p className="text-sm font-semibold">{q.title}</p>}
                    <p className="font-medium">{q.text}</p>
                    <div className="space-y-1">
                      {q.options.map((opt) => (
                        <div key={opt.id} className={`text-sm flex items-center gap-2 ${opt.isCorrect ? "text-green-700 font-medium" : "text-muted-foreground"}`}>
                          <span className={`size-3 rounded-full shrink-0 ${opt.isCorrect ? "bg-green-500" : "bg-muted-foreground/30"}`} />
                          {opt.text}
                        </div>
                      ))}
                    </div>
                    {(q.points || q.feedbackGeneral) && (
                      <div className="text-xs text-muted-foreground space-y-1">
                        {q.points ? <p>Points: {q.points}</p> : null}
                        {q.feedbackGeneral ? <p>Feedback: {q.feedbackGeneral}</p> : null}
                      </div>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(q)}><Pencil className="size-3" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteQuestion(q.id)}><Trash2 className="size-3 text-destructive" /></Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

export default function QuestionsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading…</div>}>
      <QuestionsContent />
    </Suspense>
  );
}
