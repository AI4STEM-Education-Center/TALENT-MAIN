"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FolderInput, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";

interface ImportableMaterial {
  id: string;
  title: string | null;
  originalName: string;
  totalPages: number;
  createdAt: string;
}

interface ImportableClass {
  id: string;
  name: string;
  materials: ImportableMaterial[];
}

interface MaterialImportDialogProps {
  classId: string;
}

export default function MaterialImportDialog({ classId }: MaterialImportDialogProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  // Synchronous re-entry guard; see material-delete-button.
  const inFlight = useRef(false);
  const [classes, setClasses] = useState<ImportableClass[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadImportable = async () => {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    try {
      const res = await fetch(`/api/classes/${classId}/materials/importable`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error("Failed to load materials");
      const data = await res.json();
      setClasses(Array.isArray(data.classes) ? data.classes : []);
    } catch (err) {
      console.error(err);
      setError("Could not load materials to import.");
      setClasses([]);
    } finally {
      setLoading(false);
    }
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) loadImportable();
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const copy = new Set(prev);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  };

  const handleImport = async () => {
    if (selected.size === 0) return;
    // `importing` is state and does not disable the button until the next
    // render, so a fast double click could import the same materials twice.
    if (inFlight.current) return;
    inFlight.current = true;
    setImporting(true);
    try {
      const res = await fetch(`/api/classes/${classId}/materials/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ materialIds: Array.from(selected) }),
      });
      if (!res.ok) throw new Error("Failed to import materials");
      setOpen(false);
      router.refresh();
    } catch (err) {
      console.error(err);
      setError("An error occurred while importing.");
    } finally {
      inFlight.current = false;
      setImporting(false);
    }
  };

  const hasItems = classes.some((c) => c.materials.length > 0);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-x-2 text-sm font-medium text-blue-600 hover:text-blue-500"
        >
          <FolderInput className="size-4" /> Import from another class
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Materials</DialogTitle>
          <DialogDescription>
            Share a material from another of your classes. The same file is reused, so no re-upload is needed.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-gray-500">
              <Loader2 className="size-5 animate-spin mr-2" /> Loading…
            </div>
          ) : error ? (
            <div className="py-6 text-center text-sm text-red-600">{error}</div>
          ) : !hasItems ? (
            <div className="py-10 text-center text-sm text-gray-500">
              No other materials available to import.
            </div>
          ) : (
            <div className="space-y-5">
              {classes.map((cls) => (
                <div key={cls.id}>
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">{cls.name}</h3>
                  <div className="space-y-2">
                    {cls.materials.map((mat) => (
                      <label
                        key={mat.id}
                        className="flex items-center gap-3 p-3 rounded-md border hover:bg-gray-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(mat.id)}
                          onChange={() => toggle(mat.id)}
                          className="size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-900 truncate">
                            {mat.title || mat.originalName}
                          </p>
                          <p className="text-xs text-gray-500">{mat.totalPages} Pages</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={handleImport}
            disabled={importing || selected.size === 0}
            className="inline-flex items-center justify-center gap-x-2 px-4 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {importing && <Loader2 className="size-4 animate-spin" />}
            Import selected{selected.size > 0 ? ` (${selected.size})` : ""}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
