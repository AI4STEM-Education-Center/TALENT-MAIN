"use client";
import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ArrowLeft, Plus, Eye, EyeOff, Trash2, FileQuestion, Settings, Clock } from "lucide-react";

interface Topic { id: string; name: string }
interface Quiz { id: string; name: string; topic: Topic | null; _count: { questions: number } }
interface ClassQuiz {
  id: string;
  quizId: string;
  published: boolean;
  availableFrom?: string | Date | null;
  availableUntil?: string | Date | null;
  maxAttempts?: number | null;
  quiz: Quiz;
}

/** Format a stored timestamp for the compact summary badge (e.g. "Jun 20"). */
function formatShort(value?: string | Date | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Convert a stored timestamp into the local `YYYY-MM-DDTHH:mm` a datetime-local wants. */
function toLocalInput(value?: string | Date | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

/** A datetime-local input value → ISO string (or null when cleared). */
function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Compact summary of a quiz's per-class settings (window + attempt cap). */
function SettingsSummary({ cq }: { cq: ClassQuiz }) {
  const parts: string[] = [];
  if (cq.availableFrom) parts.push(`Opens ${formatShort(cq.availableFrom)}`);
  if (cq.availableUntil) parts.push(`Closes ${formatShort(cq.availableUntil)}`);
  if (cq.maxAttempts && cq.maxAttempts > 0) {
    parts.push(`${cq.maxAttempts} attempt${cq.maxAttempts !== 1 ? "s" : ""}`);
  }
  if (parts.length === 0) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <Clock className="size-3" /> {parts.join(" · ")}
    </span>
  );
}

export function ClassQuizzesClient({
  classId,
  initialClassQuizzes,
  initialAllQuizzes,
}: {
  classId: string;
  initialClassQuizzes: ClassQuiz[];
  initialAllQuizzes: Quiz[];
}) {
  const confirm = useConfirm();
  const [classQuizzes, setClassQuizzes] = useState<ClassQuiz[]>(initialClassQuizzes);
  const [allQuizzes] = useState<Quiz[]>(initialAllQuizzes);
  const [msg, setMsg] = useState("");

  // The quiz whose settings dialog is open, plus its working form values.
  const [editing, setEditing] = useState<ClassQuiz | null>(null);
  const [form, setForm] = useState({ availableFrom: "", availableUntil: "", maxAttempts: "" });
  const [saving, setSaving] = useState(false);

  const assignedQuizIds = new Set(classQuizzes.map((cq) => cq.quizId));
  const availableQuizzes = allQuizzes.filter((q) => !assignedQuizIds.has(q.id));

  function openSettings(cq: ClassQuiz) {
    setForm({
      availableFrom: toLocalInput(cq.availableFrom),
      availableUntil: toLocalInput(cq.availableUntil),
      maxAttempts: cq.maxAttempts && cq.maxAttempts > 0 ? String(cq.maxAttempts) : "",
    });
    setEditing(cq);
  }

  async function saveSettings() {
    if (!editing) return;
    setSaving(true);
    const availableFrom = fromLocalInput(form.availableFrom);
    const availableUntil = fromLocalInput(form.availableUntil);
    const maxAttempts = form.maxAttempts.trim() === "" ? null : Number(form.maxAttempts);
    const res = await fetch(`/api/classes/${classId}/quizzes`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quizId: editing.quizId, availableFrom, availableUntil, maxAttempts }),
    });
    setSaving(false);
    if (res.ok) {
      setClassQuizzes((prev) =>
        prev.map((cq) =>
          cq.quizId === editing.quizId
            ? { ...cq, availableFrom, availableUntil, maxAttempts }
            : cq
        )
      );
      setEditing(null);
      setMsg("Quiz settings saved.");
    } else {
      setMsg("Could not save settings.");
    }
  }

  async function addQuiz(quizId: string) {
    const res = await fetch(`/api/classes/${classId}/quizzes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quizId }),
    });
    if (res.ok) {
      const cq = await res.json();
      const quiz = allQuizzes.find((q) => q.id === quizId)!;
      setClassQuizzes((prev) => [...prev, { ...cq, quiz }]);
      setMsg("Quiz added.");
    }
  }

  async function togglePublish(quizId: string, current: boolean) {
    const res = await fetch(`/api/classes/${classId}/quizzes`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quizId, published: !current }),
    });
    if (res.ok) {
      setClassQuizzes((prev) => prev.map((cq) => cq.quizId === quizId ? { ...cq, published: !current } : cq));
      setMsg(!current ? "Quiz published — students can now take it." : "Quiz unpublished — hidden from students.");
    }
  }

  async function removeQuiz(quizId: string) {
    const ok = await confirm({
      title: "Remove this quiz from the class?",
      confirmText: "Remove",
      variant: "destructive",
    });
    if (!ok) return;
    const res = await fetch(`/api/classes/${classId}/quizzes`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quizId }),
    });
    if (res.ok) {
      setClassQuizzes((prev) => prev.filter((cq) => cq.quizId !== quizId));
      setMsg("Quiz removed.");
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/teacher/classes/${classId}`}><ArrowLeft className="size-4" /> Back to class</Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold">Manage Quizzes</h1>
        <p className="text-muted-foreground text-sm mt-1">Add your quizzes to this class and control when students can take them.</p>
      </div>

      {msg && (
        <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>
      )}

      {/* Assigned Quizzes */}
      <Card>
        <CardHeader>
          <CardTitle>Assigned Quizzes ({classQuizzes.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {classQuizzes.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-6">No quizzes assigned. Add one below.</p>
          ) : (
            <div className="space-y-3">
              {classQuizzes.map((cq) => (
                <div key={cq.id} className="flex items-start justify-between gap-2 flex-wrap p-3 rounded-lg border">
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <FileQuestion className="size-4 text-muted-foreground shrink-0" />
                      <span className="font-medium">{cq.quiz.name}</span>
                      {cq.quiz.topic && <Badge variant="outline">{cq.quiz.topic.name}</Badge>}
                      <Badge variant={cq.published ? "success" : "warning"}>
                        {cq.published ? "Published" : "Draft"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 ml-6">
                      {cq.quiz._count.questions} question{cq.quiz._count.questions !== 1 ? "s" : ""}
                    </p>
                    <div className="mt-1 ml-6">
                      <SettingsSummary cq={cq} />
                    </div>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <Button size="sm" variant="outline" onClick={() => openSettings(cq)}>
                      <Settings className="size-3" /> Settings
                    </Button>
                    <Button
                      size="sm"
                      variant={cq.published ? "secondary" : "default"}
                      onClick={() => togglePublish(cq.quizId, cq.published)}
                    >
                      {cq.published ? <><EyeOff className="size-3" /> Unpublish</> : <><Eye className="size-3" /> Publish</>}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => removeQuiz(cq.quizId)}>
                      <Trash2 className="size-3 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Available Quizzes */}
      {availableQuizzes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Add Quizzes</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {availableQuizzes.map((q) => (
                <div key={q.id} className="flex items-center justify-between p-3 rounded-lg border border-dashed">
                  <div>
                    <p className="font-medium">{q.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {q.topic ? `${q.topic.name} · ` : ""}{q._count.questions} question{q._count.questions !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => addQuiz(q.id)}>
                    <Plus className="size-3" /> Add
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {availableQuizzes.length === 0 && classQuizzes.length > 0 && (
        <p className="text-sm text-muted-foreground text-center">
          All of your quizzes are assigned.{" "}
          <Link href="/teacher/quizzes" className="text-primary hover:underline">Create new quizzes</Link> to add more.
        </p>
      )}

      {allQuizzes.length === 0 && (
        <Card>
          <CardContent className="text-center py-10">
            <p className="text-muted-foreground mb-3">You don&apos;t have any quizzes yet.</p>
            <Button asChild><Link href="/teacher/quizzes"><Plus className="size-4" /> Create Quizzes</Link></Button>
          </CardContent>
        </Card>
      )}

      {/* Per-class quiz settings dialog */}
      <Dialog open={!!editing} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quiz settings{editing ? ` — ${editing.quiz.name}` : ""}</DialogTitle>
            <DialogDescription>
              Control when this quiz is open and how many attempts each student gets. Leave a field
              blank for no limit.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="availableFrom">Opens</Label>
              <Input
                id="availableFrom"
                type="datetime-local"
                value={form.availableFrom}
                onChange={(e) => setForm((f) => ({ ...f, availableFrom: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">Blank = always open.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="availableUntil">Closes</Label>
              <Input
                id="availableUntil"
                type="datetime-local"
                value={form.availableUntil}
                onChange={(e) => setForm((f) => ({ ...f, availableUntil: e.target.value }))}
              />
              <p className="text-xs text-muted-foreground">Blank = never closes.</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maxAttempts">Max attempts</Label>
              <Input
                id="maxAttempts"
                type="number"
                min={1}
                step={1}
                value={form.maxAttempts}
                onChange={(e) => setForm((f) => ({ ...f, maxAttempts: e.target.value }))}
                placeholder="Unlimited"
                className="max-w-32"
              />
              <p className="text-xs text-muted-foreground">Blank or 0 = unlimited (1 = a single try).</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={saveSettings} disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
