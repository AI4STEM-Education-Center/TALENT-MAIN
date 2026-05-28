"use client";
import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, Check, X, ArrowLeft, FileQuestion } from "lucide-react";

interface Option { id?: string; text: string; isCorrect: boolean }
interface Question { id: string; text: string; difficultyLevel: string; subtopicId: string; topicId: string; options: Option[]; subtopic: { name: string }; topic: { name: string } }
interface Subtopic { id: string; name: string }
interface Topic { id: string; name: string; subtopics: Subtopic[] }

function QuestionsContent() {
  const searchParams = useSearchParams();
  const filterSubtopicId = searchParams.get("subtopicId") || "";
  const filterTopicId = searchParams.get("topicId") || "";

  const [questions, setQuestions] = useState<Question[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingQuestion, setEditingQuestion] = useState<Question | null>(null);
  const [form, setForm] = useState({ text: "", topicId: filterTopicId, subtopicId: filterSubtopicId, difficultyLevel: "BEGINNER", options: [{ text: "", isCorrect: false }, { text: "", isCorrect: false }, { text: "", isCorrect: false }, { text: "", isCorrect: false }] });
  const [msg, setMsg] = useState("");

  const subtopicsForTopic = topics.find((t) => t.id === form.topicId)?.subtopics || [];

  useEffect(() => {
    const params = new URLSearchParams();
    if (filterTopicId) params.set("topicId", filterTopicId);
    if (filterSubtopicId) params.set("subtopicId", filterSubtopicId);

    Promise.all([
      fetch(`/api/questions?${params}`).then((r) => r.json()),
      fetch("/api/topics").then((r) => r.json()),
    ]).then(([qs, ts]) => { setQuestions(qs); setTopics(ts); setLoading(false); });
  }, [filterTopicId, filterSubtopicId]);

  function startEdit(q: Question) {
    setEditingQuestion(q);
    setForm({ text: q.text, topicId: q.topicId, subtopicId: q.subtopicId, difficultyLevel: q.difficultyLevel, options: q.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect })) });
    setShowForm(true);
  }

  function resetForm() {
    setForm({ text: "", topicId: filterTopicId, subtopicId: filterSubtopicId, difficultyLevel: "BEGINNER", options: [{ text: "", isCorrect: false }, { text: "", isCorrect: false }, { text: "", isCorrect: false }, { text: "", isCorrect: false }] });
    setEditingQuestion(null);
    setShowForm(false);
  }

  function setOption(index: number, field: "text" | "isCorrect", value: string | boolean) {
    setForm((prev) => ({ ...prev, options: prev.options.map((o, i) => i === index ? { ...o, [field]: value } : o) }));
  }

  function markCorrect(index: number) {
    setForm((prev) => ({ ...prev, options: prev.options.map((o, i) => ({ ...o, isCorrect: i === index })) }));
  }

  async function saveQuestion() {
    const validOptions = form.options.filter((o) => o.text.trim());
    if (!form.text.trim() || !form.topicId || !form.subtopicId) { setMsg("Fill in question text, topic and module."); return; }
    if (validOptions.length < 2) { setMsg("Add at least 2 options."); return; }
    if (!validOptions.some((o) => o.isCorrect)) { setMsg("Mark one option as correct."); return; }

    const method = editingQuestion ? "PATCH" : "POST";
    const body = editingQuestion ? { id: editingQuestion.id, text: form.text, difficultyLevel: form.difficultyLevel, options: validOptions } : { ...form, options: validOptions };

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
    if (!confirm("Delete this question?")) return;
    await fetch("/api/questions", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    setQuestions((prev) => prev.filter((q) => q.id !== id));
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  const subtopicName = filterSubtopicId ? questions[0]?.subtopic?.name : null;
  const topicName = filterTopicId ? questions[0]?.topic?.name : null;

  return (
    <div className="p-6 space-y-6">
      {filterTopicId && (
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/teacher/topics/${filterTopicId}`}><ArrowLeft className="w-4 h-4" /> Back to modules</Link>
        </Button>
      )}

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Question Bank</h1>
          {subtopicName && topicName && <p className="text-muted-foreground text-sm mt-1">Filtered: {topicName} › {subtopicName}</p>}
        </div>
        <Button onClick={() => { resetForm(); setShowForm(true); }}>
          <Plus className="w-4 h-4" /> Add Question
        </Button>
      </div>

      {msg && <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>}

      {/* Form */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>{editingQuestion ? "Edit Question" : "New Question"}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
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
              <Label>Question Text</Label>
              <Textarea value={form.text} onChange={(e) => setForm((p) => ({ ...p, text: e.target.value }))} rows={3} placeholder="Enter the question..." />
            </div>
            <div className="space-y-2">
              <Label>Options <span className="text-muted-foreground text-xs">(click radio to mark correct)</span></Label>
              {form.options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <button type="button" onClick={() => markCorrect(i)} className={`w-4 h-4 rounded-full border-2 flex-shrink-0 ${opt.isCorrect ? "bg-green-500 border-green-500" : "border-muted-foreground"}`} />
                  <Input placeholder={`Option ${i + 1}`} value={opt.text} onChange={(e) => setOption(i, "text", e.target.value)} />
                </div>
              ))}
              <Button variant="ghost" size="sm" onClick={() => setForm((p) => ({ ...p, options: [...p.options, { text: "", isCorrect: false }] }))}>
                <Plus className="w-3 h-3" /> Add option
              </Button>
            </div>
            <div className="flex gap-3">
              <Button onClick={saveQuestion}><Check className="w-4 h-4" /> {editingQuestion ? "Update" : "Save"}</Button>
              <Button variant="outline" onClick={resetForm}><X className="w-4 h-4" /> Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Questions List */}
      {questions.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 text-muted-foreground">
            <FileQuestion className="w-10 h-10 mx-auto mb-3" />
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
                      <Badge variant="secondary" className="text-xs">{q.subtopic?.name}</Badge>
                    </div>
                    <p className="font-medium">{q.text}</p>
                    <div className="space-y-1">
                      {q.options.map((opt) => (
                        <div key={opt.id} className={`text-sm flex items-center gap-2 ${opt.isCorrect ? "text-green-700 font-medium" : "text-muted-foreground"}`}>
                          <span className={`w-3 h-3 rounded-full flex-shrink-0 ${opt.isCorrect ? "bg-green-500" : "bg-muted-foreground/30"}`} />
                          {opt.text}
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="flex gap-1 flex-shrink-0">
                    <Button size="sm" variant="ghost" onClick={() => startEdit(q)}><Pencil className="w-3 h-3" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => deleteQuestion(q.id)}><Trash2 className="w-3 h-3 text-destructive" /></Button>
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
    <Suspense fallback={<div className="p-6 text-muted-foreground">Loading...</div>}>
      <QuestionsContent />
    </Suspense>
  );
}
