"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus, Pencil, Trash2, Check, X, Layers } from "lucide-react";

interface Subtopic { id: string; name: string; order: number; _count: { questions: number } }

export default function TopicModulesPage() {
  const { id: topicId } = useParams<{ id: string }>();
  const [topicName, setTopicName] = useState("");
  const [subtopics, setSubtopics] = useState<Subtopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/topics").then((r) => r.json()),
      fetch(`/api/topics/${topicId}/subtopics`).then((r) => r.json()),
    ]).then(([topics, subs]) => {
      const t = topics.find((tp: { id: string; name: string }) => tp.id === topicId);
      if (t) setTopicName(t.name);
      setSubtopics(subs);
      setLoading(false);
    });
  }, [topicId]);

  async function createSubtopic() {
    if (!newName.trim()) return;
    const maxOrder = subtopics.reduce((m, s) => Math.max(m, s.order), 0);
    const res = await fetch(`/api/topics/${topicId}/subtopics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName.trim(), order: maxOrder + 1 }),
    });
    if (res.ok) {
      const s = await res.json();
      setSubtopics((prev) => [...prev, { ...s, _count: { questions: 0 } }]);
      setNewName("");
      setMsg("Module created.");
    }
  }

  async function saveEdit(subtopicId: string) {
    await fetch(`/api/topics/${topicId}/subtopics`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtopicId, name: editName }),
    });
    setSubtopics((prev) => prev.map((s) => s.id === subtopicId ? { ...s, name: editName } : s));
    setEditingId(null);
    setMsg("Module updated.");
  }

  async function deleteSubtopic(subtopicId: string) {
    if (!confirm("Delete this module and all its questions?")) return;
    await fetch(`/api/topics/${topicId}/subtopics`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subtopicId }),
    });
    setSubtopics((prev) => prev.filter((s) => s.id !== subtopicId));
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  return (
    <div className="p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/teacher/topics"><ArrowLeft className="w-4 h-4" /> Topics</Link>
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{topicName}</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage subtopic modules — each module has a set of quiz questions.</p>
      </div>

      {msg && <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>}

      <Card>
        <CardHeader><CardTitle>Add Module</CardTitle></CardHeader>
        <CardContent>
          <div className="flex gap-3">
            <Input placeholder="Module name (e.g. Nature of temperature)" value={newName}
              onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createSubtopic()} />
            <Button onClick={createSubtopic} disabled={!newName.trim()}><Plus className="w-4 h-4" /> Add</Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-2">
        {subtopics.length === 0 && (
          <Card>
            <CardContent className="text-center py-10 text-muted-foreground">
              <Layers className="w-8 h-8 mx-auto mb-2" />
              <p>No modules yet. Add one above.</p>
            </CardContent>
          </Card>
        )}
        {subtopics.map((s, i) => (
          <Card key={s.id}>
            <CardContent className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3 flex-1">
                <span className="text-sm font-mono text-muted-foreground w-6">{i + 1}.</span>
                {editingId === s.id ? (
                  <div className="flex items-center gap-2 flex-1">
                    <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="h-8" autoFocus />
                    <Button size="sm" variant="ghost" onClick={() => saveEdit(s.id)}><Check className="w-3 h-3" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}><X className="w-3 h-3" /></Button>
                  </div>
                ) : (
                  <div className="flex-1">
                    <span className="font-medium">{s.name}</span>
                    <Badge variant="outline" className="ml-2 text-xs">{s._count.questions} questions</Badge>
                  </div>
                )}
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => { setEditingId(s.id); setEditName(s.name); }}>
                  <Pencil className="w-3 h-3" />
                </Button>
                <Button size="sm" variant="ghost" asChild>
                  <Link href={`/teacher/questions?subtopicId=${s.id}&topicId=${topicId}`}>Questions</Link>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => deleteSubtopic(s.id)}>
                  <Trash2 className="w-3 h-3 text-destructive" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
