"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Plus, Eye, EyeOff, Trash2, BookOpen } from "lucide-react";

interface Subtopic { id: string; name: string; order: number }
interface Topic { id: string; name: string; order: number; subtopics: Subtopic[] }
interface ClassTopic { id: string; topicId: string; published: boolean; topic: Topic }

export default function ClassTopicsPage() {
  const { id: classId } = useParams<{ id: string }>();
  const router = useRouter();
  const [classTopics, setClassTopics] = useState<ClassTopic[]>([]);
  const [allTopics, setAllTopics] = useState<Topic[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    Promise.all([
      fetch(`/api/classes/${classId}/topics`).then((r) => r.json()),
      fetch("/api/topics").then((r) => r.json()),
    ]).then(([cts, topics]) => {
      setClassTopics(cts);
      setAllTopics(topics);
      setLoading(false);
    });
  }, [classId]);

  const assignedTopicIds = new Set(classTopics.map((ct) => ct.topicId));
  const availableTopics = allTopics.filter((t) => !assignedTopicIds.has(t.id));

  async function addTopic(topicId: string) {
    const res = await fetch(`/api/classes/${classId}/topics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId }),
    });
    if (res.ok) {
      const ct = await res.json();
      const topic = allTopics.find((t) => t.id === topicId)!;
      setClassTopics((prev) => [...prev, { ...ct, topic }]);
      setMsg("Topic added.");
    }
  }

  async function togglePublish(topicId: string, current: boolean) {
    const res = await fetch(`/api/classes/${classId}/topics`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId, published: !current }),
    });
    if (res.ok) {
      setClassTopics((prev) => prev.map((ct) => ct.topicId === topicId ? { ...ct, published: !current } : ct));
      setMsg(!current ? "Topic published — students can now see it." : "Topic unpublished — hidden from students.");
    }
  }

  async function removeTopic(topicId: string) {
    if (!confirm("Remove this topic from the class?")) return;
    const res = await fetch(`/api/classes/${classId}/topics`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId }),
    });
    if (res.ok) {
      setClassTopics((prev) => prev.filter((ct) => ct.topicId !== topicId));
      setMsg("Topic removed.");
    }
  }

  if (loading) return <div className="p-6 text-muted-foreground">Loading...</div>;

  return (
    <div className="p-6 space-y-6">
      <div>
        <Button variant="ghost" size="sm" asChild>
          <Link href={`/teacher/classes/${classId}`}><ArrowLeft className="w-4 h-4" /> Back to class</Link>
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold">Manage Topics</h1>
        <p className="text-muted-foreground text-sm mt-1">Add topics to this class and control when students can see them.</p>
      </div>

      {msg && (
        <div className="p-3 rounded-md bg-primary/10 text-primary text-sm">{msg}</div>
      )}

      {/* Assigned Topics */}
      <Card>
        <CardHeader>
          <CardTitle>Assigned Topics ({classTopics.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {classTopics.length === 0 ? (
            <p className="text-muted-foreground text-sm text-center py-6">No topics assigned. Add one below.</p>
          ) : (
            <div className="space-y-3">
              {classTopics.map((ct) => (
                <div key={ct.id} className="flex items-center justify-between p-3 rounded-lg border">
                  <div>
                    <div className="flex items-center gap-2">
                      <BookOpen className="w-4 h-4 text-muted-foreground" />
                      <span className="font-medium">{ct.topic.name}</span>
                      <Badge variant={ct.published ? "success" : "warning"}>
                        {ct.published ? "Published" : "Draft"}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 ml-6">
                      {ct.topic.subtopics.length} module{ct.topic.subtopics.length !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant={ct.published ? "secondary" : "default"}
                      onClick={() => togglePublish(ct.topicId, ct.published)}
                    >
                      {ct.published ? <><EyeOff className="w-3 h-3" /> Unpublish</> : <><Eye className="w-3 h-3" /> Publish</>}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => removeTopic(ct.topicId)}>
                      <Trash2 className="w-3 h-3 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Available Topics */}
      {availableTopics.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Add Topics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {availableTopics.map((t) => (
                <div key={t.id} className="flex items-center justify-between p-3 rounded-lg border border-dashed">
                  <div>
                    <p className="font-medium">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.subtopics.length} modules</p>
                  </div>
                  <Button size="sm" variant="outline" onClick={() => addTopic(t.id)}>
                    <Plus className="w-3 h-3" /> Add
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {availableTopics.length === 0 && classTopics.length > 0 && (
        <p className="text-sm text-muted-foreground text-center">
          All available topics are assigned.{" "}
          <Link href="/teacher/topics" className="text-primary hover:underline">Create new topics</Link> to add more.
        </p>
      )}

      {allTopics.length === 0 && (
        <Card>
          <CardContent className="text-center py-10">
            <p className="text-muted-foreground mb-3">No topics exist yet.</p>
            <Button asChild><Link href="/teacher/topics"><Plus className="w-4 h-4" /> Create Topics</Link></Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
