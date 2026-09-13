"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Download, Globe, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

interface PoolMaterial {
  id: string;
  title: string | null;
  originalName: string;
  totalPages: number;
  alreadyImported: boolean;
  topic: { id: string; name: string } | null;
}

function grouped(materials: PoolMaterial[]) {
  const groups = new Map<string, { name: string; items: PoolMaterial[] }>();
  for (const material of materials) {
    const key = material.topic?.id ?? "__ungrouped";
    const group = groups.get(key) ?? { name: material.topic?.name ?? "No topic", items: [] };
    group.items.push(material);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}

export default function MaterialPoolImportDialog({ classId }: { classId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const [materials, setMaterials] = useState<PoolMaterial[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  async function loadPool() {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const response = await fetch("/api/materials/pool", { cache: "no-store" });
      if (!response.ok) throw new Error("Could not load the global pool.");
      const data = await response.json();
      setMaterials(data.materials ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the global pool.");
    } finally {
      setLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) void loadPool();
  }

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function importSelected() {
    if (importingRef.current) return;
    if (selected.size === 0) return;
    importingRef.current = true;
    setImporting(true);
    setError(null);
    try {
      const response = await fetch(`/api/classes/${classId}/materials/pool/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ materialIds: Array.from(selected) }),
      });
      if (!response.ok) throw new Error("Import failed.");
      await response.json();
      setOpen(false);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import failed.");
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button type="button" className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-500">
          <Globe className="size-4" /> Import from global pool
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Global learning-material pool</DialogTitle>
          <DialogDescription>
            Browse materials by topic and import independent copies into this class.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[55vh] space-y-5 overflow-y-auto px-1">
          {loading ? (
            <div className="flex justify-center py-10 text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Loading materials…
            </div>
          ) : materials.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">The global material pool is empty.</p>
          ) : (
            grouped(materials).map((group) => (
              <section key={group.name}>
                <h3 className="mb-2 text-sm font-semibold">{group.name}</h3>
                <div className="space-y-2">
                  {group.items.map((material) => (
                    <label key={material.id} className="flex cursor-pointer items-center gap-3 rounded-md border p-3 hover:bg-muted/40">
                      <input
                        type="checkbox"
                        checked={selected.has(material.id)}
                        onChange={() => toggle(material.id)}
                        className="size-4"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{material.title || material.originalName}</span>
                        <span className="text-xs text-muted-foreground">
                          {material.totalPages} pages{material.alreadyImported ? " · Previously imported" : ""}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
            ))
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={importSelected}
            disabled={importing || selected.size === 0}
            className="inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {importing ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
            Import selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
