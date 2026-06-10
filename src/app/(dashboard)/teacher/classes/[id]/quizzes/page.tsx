"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { ArrowLeft, Plus, Eye, EyeOff, Trash2, FileQuestion } from "lucide-react";

interface Topic { id: string; name: string }
interface Quiz { id: string; name: string; topic: Topic | null; _count: { questions: number } }
interface ClassQuiz { id: string; quizId: string; published: boolean; quiz: Quiz }

export default function ClassQuizzesPage() {
  const { id: classId } = useParams<{ id: string }>();
  const confirm = useConfirm();
  const [classQuizzes, setClassQuizzes] = useState<ClassQuiz[]>([]);
  const [allQuizzes, setAllQuizzes] = useState<Quiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`/api/classes/${classId}/quizzes`).then((r) => r.json()),
      fetch("/api/quizzes").then((r) => r.json()),
    ]).then(([cqs, quizzes]) => {
      setClassQuizzes(cqs);
      setAllQuizzes(quizzes);
      setLoading(false);
    });
  }, [classId]);

  const assignedQuizIds = new Set(classQuizzes.map((cq) => cq.quizId));
  const availableQuizzes = allQuizzes.filter((q) => !assignedQuizIds.has(q.id));

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

  if (loading) return <div className="p-6 text-muted-foreground">Loading…</div>;

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
                  </div>
                  <div className="flex gap-2 shrink-0">
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
    </div>
  );
}
