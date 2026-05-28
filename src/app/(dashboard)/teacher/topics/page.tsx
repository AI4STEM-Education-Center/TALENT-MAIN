"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Plus, BookOpen, ChevronRight, Pencil, Trash2, Check, X } from "lucide-react";

interface Subtopic { id: string; name: string; order: number }
interface Topic { id: string; name: string; order: number; subtopics: Subtopic[]; _count: { questions: number } }

export default function TopicsPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    fetch("/api/topics").then((r) => r.json()).then((data) => { setTopics(data); setLoading(false); });
  }, []);

  async function createTopic() {
    if (!newName.trim()) return;
    const maxOrder = topics.reduce((m, t) => Math.max(m, t.order), 0);
    const res = await fetch("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), order: maxOrder + 1 }),
    });
    if (res.ok) {
      const t = await res.json();
      setTopics((prev) => [...prev, { ...t, subtopics: [], _count: { questions: 0 } }]);
      setNewName("");
      setMsg("Topic created.");
    }
  }

  async function deleteTopic(id: string) {
    if (!confirm("Delete this topic and all its subtopics and questions?")) return;
    const res = await fetch("/api/topics", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (res.ok) setTopics((prev) => prev.filter((t) => t.id !== id));
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Topics & Modules</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage the learning topics and their subtopic modules.</p>
      </div>

      {msg && <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>}

      {/* Create Topic */}
      <Card>
        <CardHeader><CardTitle>Create New Topic</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Input placeholder="Topic name (e.g. Thermodynamics)" value={newName} onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createTopic()} />
            <Button onClick={createTopic} disabled={!newName.trim()}><Plus className="w-4 h-4" /> Create</Button>
          </div>
        </CardContent>
      </Card>

      {/* Topics List */}
      <div className="space-y-3">
        {topics.length === 0 && (
          <Card>
            <CardContent className="text-center py-12 text-muted-foreground">
              <BookOpen className="w-10 h-10 mx-auto mb-3" />
              <p>No topics yet. Create one above to get started.</p>
            </CardContent>
          </Card>
        )}
        {topics.map((topic) => (
          <Card key={topic.id} className="hover:shadow-sm transition-shadow">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 flex-1">
                  <BookOpen className="w-5 h-5 text-primary" />
                  {editingId === topic.id ? (
                    <div className="flex items-center gap-2 flex-1">
                      <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8" autoFocus />
                      <Button size="sm" variant="ghost" onClick={async () => {
                        await fetch("/api/topics", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: topic.id, name: editName }) });
                        setTopics((prev) => prev.map((t) => t.id === topic.id ? { ...t, name: editName } : t));
                        setEditingId(null);
                      }}><Check className="w-3 h-3" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}><X className="w-3 h-3" /></Button>
                    </div>
                  ) : (
                    <div className="flex-1">
                      <span className="font-semibold">{topic.name}</span>
                      <div className="flex gap-3 mt-1">
                        <Badge variant="secondary">{topic.subtopics.length} modules</Badge>
                        <Badge variant="outline">{topic._count.questions} questions</Badge>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => { setEditingId(topic.id); setEditName(topic.name); }}>
                    <Pencil className="w-3 h-3" />
                  </Button>
                  <Button size="sm" variant="ghost" asChild>
                    <Link href={`/teacher/topics/${topic.id}`}><ChevronRight className="w-4 h-4" /> Modules</Link>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => deleteTopic(topic.id)}>
                    <Trash2 className="w-3 h-3 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
