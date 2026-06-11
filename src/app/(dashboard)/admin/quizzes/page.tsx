"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Plus, Pencil, Trash2, FileQuestion, Globe, ArrowUpToLine, BookOpen, Check, X } from "lucide-react";

interface Topic { id: string; name: string; order: number; _count: { quizzes: number } }
interface PoolQuiz {
  id: string;
  name: string;
  topicId: string | null;
  topic: Topic | null;
  _count: { questions: number };
}
interface TeacherQuiz extends PoolQuiz {
  teacher: { user: { firstName: string; lastName: string; email: string } };
  alreadyPromoted: boolean;
}

/** Group quizzes under their (optional) topic label; ungrouped quizzes last. */
function groupByTopic(quizzes: PoolQuiz[]) {
  const groups = new Map<string, { topicName: string | null; quizzes: PoolQuiz[] }>();
  for (const quiz of quizzes) {
    const key = quiz.topic ? `topic:${quiz.topic.id}` : "ungrouped";
    const group = groups.get(key) ?? { topicName: quiz.topic?.name ?? null, quizzes: [] };
    group.quizzes.push(quiz);
    groups.set(key, group);
  }
  return Array.from(groups.values()).toSorted((a, b) => {
    if (a.topicName === null) return 1;
    if (b.topicName === null) return -1;
    return 0;
  });
}

export default function AdminQuizPoolPage() {
  const confirm = useConfirm();
  const router = useRouter();
  const [tab, setTab] = useState<"pool" | "teachers">("pool");
  const [pool, setPool] = useState<PoolQuiz[]>([]);
  const [teacherQuizzes, setTeacherQuizzes] = useState<TeacherQuiz[]>([]);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [newQuizName, setNewQuizName] = useState("");
  const [newQuizTopicId, setNewQuizTopicId] = useState("");
  const [newTopicName, setNewTopicName] = useState("");
  const [editingTopicId, setEditingTopicId] = useState<string | null>(null);
  const [editTopicName, setEditTopicName] = useState("");
  const [promoteBusyId, setPromoteBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/quizzes").then((r) => r.json()),
      fetch("/api/admin/quizzes").then((r) => r.json()),
      fetch("/api/topics").then((r) => r.json()),
    ]).then(([poolQuizzes, teacherOwned, ts]) => {
      setPool(poolQuizzes);
      setTeacherQuizzes(teacherOwned);
      setTopics(ts);
      setLoading(false);
    });
  }, []);

  async function createPoolQuiz() {
    if (!newQuizName.trim()) return;
    const res = await fetch("/api/quizzes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newQuizName.trim(), topicId: newQuizTopicId || null }),
    });
    if (res.ok) {
      const quiz = await res.json();
      // Jump straight into the new quiz so questions can be added right away.
      router.push(`/admin/quizzes/${quiz.id}`);
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

  async function createTopic() {
    if (!newTopicName.trim()) return;
    const res = await fetch("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTopicName.trim() }),
    });
    if (res.ok) {
      const topic = await res.json();
      setTopics((prev) => [...prev, { ...topic, _count: { quizzes: 0 } }]);
      setNewTopicName("");
    }
  }

  async function renameTopic(id: string) {
    if (!editTopicName.trim()) return;
    const res = await fetch("/api/topics", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: editTopicName.trim() }),
    });
    if (res.ok) {
      setTopics((prev) => prev.map((t) => (t.id === id ? { ...t, name: editTopicName.trim() } : t)));
      setPool((prev) => prev.map((q) => (q.topic?.id === id ? { ...q, topic: { ...q.topic, name: editTopicName.trim() } } : q)));
      setEditingTopicId(null);
    }
  }

  async function deleteTopic(id: string) {
    const ok = await confirm({
      title: "Delete this topic label?",
      description: "Quizzes under it are kept — they just become ungrouped.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    const res = await fetch("/api/topics", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      setTopics((prev) => prev.filter((t) => t.id !== id));
      setPool((prev) => prev.map((q) => (q.topic?.id === id ? { ...q, topicId: null, topic: null } : q)));
    }
  }

  async function promote(id: string) {
    setPromoteBusyId(id);
    try {
      const res = await fetch(`/api/admin/quizzes/${id}/promote`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) { setMsg(data.error ?? "Promotion failed."); return; }
      setPool((prev) => [...prev, data]);
      if (data.topic && !topics.some((t) => t.id === data.topic.id)) {
        setTopics((prev) => [...prev, { ...data.topic, _count: { quizzes: 1 } }]);
      }
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
                <select
                  className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm sm:w-56"
                  value={newQuizTopicId}
                  onChange={(e) => setNewQuizTopicId(e.target.value)}
                  aria-label="Topic (optional)"
                >
                  <option value="">No topic (optional)</option>
                  {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
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
            <div className="space-y-6">
              {groupByTopic(pool).map((group) => (
                <div key={group.topicName ?? "__ungrouped"} className="space-y-2">
                  <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
                    <BookOpen className="size-4" /> {group.topicName ?? "No topic"}
                  </h2>
                  {group.quizzes.map((quiz) => (
                    <Card key={quiz.id} className="hover:shadow-xs transition-shadow">
                      <CardContent className="flex items-center justify-between gap-3 p-4">
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold">{quiz.name}</span>
                          <div className="flex gap-2 mt-1">
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
              ))}
            </div>
          )}

          {/* Topic labels */}
          <Card>
            <CardHeader><CardTitle className="text-base">Topic Labels</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">Topics are optional labels for grouping the global pool.</p>
              <div className="flex gap-3">
                <Input placeholder="New topic name" value={newTopicName} onChange={(e) => setNewTopicName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createTopic()} className="flex-1" />
                <Button variant="outline" onClick={createTopic} disabled={!newTopicName.trim()} className="shrink-0"><Plus className="size-4" /> Add</Button>
              </div>
              {topics.length > 0 && (
                <div className="space-y-2">
                  {topics.map((topic) => (
                    <div key={topic.id} className="flex items-center justify-between gap-2 p-2 rounded-md border">
                      {editingTopicId === topic.id ? (
                        <div className="flex items-center gap-2 flex-1">
                          <Input value={editTopicName} onChange={(e) => setEditTopicName(e.target.value)} className="h-8" autoFocus
                            onKeyDown={(e) => e.key === "Enter" && renameTopic(topic.id)} />
                          <Button size="sm" variant="ghost" onClick={() => renameTopic(topic.id)}><Check className="size-3" /></Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingTopicId(null)}><X className="size-3" /></Button>
                        </div>
                      ) : (
                        <>
                          <span className="text-sm font-medium">{topic.name}</span>
                          <div className="flex gap-1">
                            <Button size="sm" variant="ghost" onClick={() => { setEditingTopicId(topic.id); setEditTopicName(topic.name); }}>
                              <Pencil className="size-3" />
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => deleteTopic(topic.id)}>
                              <Trash2 className="size-3 text-destructive" />
                            </Button>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
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
