"use client";

import { useState } from "react";
import Link from "next/link";
import { BookOpen, FileText, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ui/confirm-dialog";

interface PoolMaterial {
  id: string;
  title: string | null;
  originalName: string;
  totalPages: number;
  topic: { id: string; name: string } | null;
}

function groupByTopic(materials: PoolMaterial[]) {
  const groups = new Map<string, { name: string; items: PoolMaterial[] }>();
  for (const material of materials) {
    const key = material.topic?.id ?? "__ungrouped";
    const group = groups.get(key) ?? { name: material.topic?.name ?? "No topic", items: [] };
    group.items.push(material);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

export function MaterialPoolClient({ initialMaterials }: { initialMaterials: PoolMaterial[] }) {
  const confirm = useConfirm();
  const [materials, setMaterials] = useState<PoolMaterial[]>(initialMaterials);
  const [newTopic, setNewTopic] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function createTopic() {
    if (!newTopic.trim()) return;
    const response = await fetch("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTopic.trim() }),
    });
    if (!response.ok) setError("Could not create the topic.");
    else setNewTopic("");
  }

  async function remove(material: PoolMaterial) {
    const approved = await confirm({
      title: "Delete this material from the global pool?",
      description: "Teacher copies already imported into classes will not be affected.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!approved) return;
    const response = await fetch(`/api/admin/materials/${material.id}`, { method: "DELETE" });
    if (response.ok) setMaterials((current) => current.filter((item) => item.id !== material.id));
    else setError("Could not delete the material.");
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-3xl font-bold">Learning-material pool</h1>
        <p className="mt-1 text-sm text-muted-foreground">Shared, approved materials organized into global topics.</p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row">
          <Input value={newTopic} onChange={(event) => setNewTopic(event.target.value)} placeholder="New global topic" onKeyDown={(event) => event.key === "Enter" && createTopic()} />
          <Button variant="outline" onClick={createTopic} disabled={!newTopic.trim()}><Plus className="size-4" /> Add topic</Button>
        </CardContent>
      </Card>
      {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
      {materials.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-muted-foreground"><FileText className="mx-auto mb-3 size-10" />No approved learning materials yet.</CardContent></Card>
      ) : (
        <div className="space-y-6">
          {groupByTopic(materials).map((group) => (
            <section key={group.name} className="space-y-2">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-muted-foreground"><BookOpen className="size-4" />{group.name}<Badge variant="secondary">{group.items.length}</Badge></h2>
              {group.items.map((material) => (
                <Card key={material.id}>
                  <CardContent className="flex items-center justify-between gap-3 p-4">
                    <div className="min-w-0">
                      <Link className="font-semibold hover:underline" href={`/admin/materials/${material.id}`}>{material.title || material.originalName}</Link>
                      <p className="text-sm text-muted-foreground">{material.totalPages} pages</p>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => remove(material)}><Trash2 className="size-4 text-destructive" /></Button>
                  </CardContent>
                </Card>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
