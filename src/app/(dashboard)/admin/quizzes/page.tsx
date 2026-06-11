"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Plus, Pencil, Trash2, FileQuestion, Globe, ArrowUpToLine } from "lucide-react";

interface Topic { id: string; name: string }
interface PoolQuiz {
  id: string;
  name: string;
  topic: Topic | null;
  _count: { questions: number };
}
interface TeacherQuiz extends PoolQuiz {
  teacher: { user: { firstName: string; lastName: string; email: string } };
  alreadyPromoted: boolean;
}

export default function AdminQuizPoolPage() {
  const confirm = useConfirm();
  const [tab, setTab] = useState<"pool" | "teachers">("pool");
  const [pool, setPool] = useState<PoolQuiz[]>([]);
  const [teacherQuizzes, setTeacherQuizzes] = useState<TeacherQuiz[]>([]);
  const [loading, setLoading] = useState(true);
  const [newQuizName, setNewQuizName] = useState("");
  const [promoteBusyId, setPromoteBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/quizzes").then((r) => r.json()),
      fetch("/api/admin/quizzes").then((r) => r.json()),
    ]).then(([poolQuizzes, teacherOwned]) => {
      setPool(poolQuizzes);
      setTeacherQuizzes(teacherOwned);
      setLoading(false);
    });
  }, []);

  async function createPoolQuiz() {
    if (!newQuizName.trim()) return;
    const res = await fetch("/api/quizzes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newQuizName.trim() }),
    });
    if (res.ok) {
      const quiz = await res.json();
      setPool((prev) => [...prev, quiz]);
      setNewQuizName("");
      setMsg("Pool quiz created — open it to add or upload questions.");
    }
  }

  async function deletePoolQuiz(id: string) {
    const ok = await confirm({
      title: "Delete this quiz from the global pool?",
      description: "Teachers' imported copies and students' past results are not affected.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const res = await fetch(`/api/quizzes/${id}`, { method: "DELETE" });
    if (res.ok) setPool((prev) => prev.filter((q) => q.id !== id));
  }

  async function promote(id: string) {
    setPromoteBusyId(id);
    try {
      const res = await fetch(`/api/admin/quizzes/${id}/promote`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error ?? "Promotion failed."); return; }
      setPool((prev) => [...prev, data]);
      setTeacherQuizzes((prev) => prev.map((q) => (q.id === id ? { ...q, alreadyPromoted: true } : q)));
      setMsg(`"${data.name}" copied to the global pool. The teacher's original stays independent.`);
    } finally {
      setPromoteBusyId(null);
    }
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading…</div>;

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Quiz Pool</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Quizzes in the global pool are visible to every teacher, who import their own independent copies.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b">
        <button
          type="button"
          onClick={() => setTab("pool")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === "pool" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          <span className="flex items-center gap-1"><Globe className="size-3.5" /> Global Pool ({pool.length})</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("teachers")}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === "teachers" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
        >
          Teacher Quizzes ({teacherQuizzes.length})
        </button>
      </div>

      {msg && <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>}

      {tab === "pool" ? (
        <>
          {/* Create pool quiz (then upload/author questions inside it) */}
          <Card>
            <CardHeader><CardTitle>Add Quiz to Pool</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm text-muted-foreground">
                Create a pool quiz, then open it to write questions or upload a QTI ZIP.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <Input placeholder="Quiz name" value={newQuizName} onChange={(e) => setNewQuizName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createPoolQuiz()} className="flex-1" />
                <Button onClick={createPoolQuiz} disabled={!newQuizName.trim()} className="shrink-0"><Plus className="size-4" /> Create</Button>
              </div>
            </CardContent>
          </Card>

          {pool.length === 0 ? (
            <Card>
              <CardContent className="text-center py-12 text-muted-foreground">
                <FileQuestion className="size-10 mx-auto mb-3" />
                <p>The pool is empty. Create a quiz above or promote one from a teacher.</p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-2">
              {pool.map((quiz) => (
                <Card key={quiz.id} className="hover:shadow-xs transition-shadow">
                  <CardContent className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <Link href={`/admin/quizzes/${quiz.id}`} className="font-semibold hover:underline">{quiz.name}</Link>
                      <div className="flex gap-2 mt-1">
                        {quiz.topic && <Badge variant="outline">{quiz.topic.name}</Badge>}
                        <Badge variant="outline">{quiz._count.questions} question{quiz._count.questions !== 1 ? "s" : ""}</Badge>
                      </div>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/admin/quizzes/${quiz.id}`}><Pencil className="size-3" /> Edit</Link>
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => deletePoolQuiz(quiz.id)}>
                        <Trash2 className="size-3 text-destructive" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      ) : (
        /* Teacher quizzes — promote a copy into the pool */
        teacherQuizzes.length === 0 ? (
          <Card>
            <CardContent className="text-center py-12 text-muted-foreground">
              <FileQuestion className="size-10 mx-auto mb-3" />
              <p>No teacher quizzes yet.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {teacherQuizzes.map((quiz) => (
              <Card key={quiz.id}>
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{quiz.name}</p>
                    <div className="flex gap-2 mt-1 flex-wrap">
                      <Badge variant="secondary">
                        {quiz.teacher.user.firstName} {quiz.teacher.user.lastName}
                      </Badge>
                      {quiz.topic && <Badge variant="outline">{quiz.topic.name}</Badge>}
                      <Badge variant="outline">{quiz._count.questions} question{quiz._count.questions !== 1 ? "s" : ""}</Badge>
                      {quiz.alreadyPromoted && <Badge variant="success">In pool</Badge>}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" className="shrink-0" disabled={promoteBusyId === quiz.id} onClick={() => promote(quiz.id)}>
                    <ArrowUpToLine className="size-3" /> {promoteBusyId === quiz.id ? "Copying…" : quiz.alreadyPromoted ? "Copy again" : "Add to pool"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}
    </div>
  );
}
