"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, FileText, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";
import type { StudentMaterial } from "@/lib/student-content";

const ALL_CLASSES = "__all__";

function displayName(material: StudentMaterial): string {
  return material.title?.trim() || material.originalName;
}

/**
 * Browsing shell for the student's material library. The server already scoped
 * the list to the student's enrolled classes; this only narrows what is on
 * screen (by class, and by a title/filename search), so it is safe to do
 * entirely on the client.
 */
export function MaterialsBrowser({
  materials,
}: {
  materials: StudentMaterial[];
}) {
  const [classId, setClassId] = useState(ALL_CLASSES);
  const [query, setQuery] = useState("");

  // Classes are derived from the materials themselves, so a class with nothing
  // shared yet never shows an always-empty filter.
  const classes = useMemo(() => {
    const seen = new Map<string, string>();
    for (const material of materials) {
      for (const cls of material.classes) seen.set(cls.id, cls.name);
    }
    return Array.from(seen, ([id, name]) => ({ id, name })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [materials]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return materials.filter((material) => {
      if (
        classId !== ALL_CLASSES &&
        !material.classes.some((c) => c.id === classId)
      )
        return false;
      if (!needle) return true;
      return (
        displayName(material).toLowerCase().includes(needle) ||
        material.originalName.toLowerCase().includes(needle) ||
        (material.topic?.name.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [materials, classId, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative sm:max-w-xs sm:flex-1">
          <Search
            aria-hidden
            className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search materials"
            aria-label="Search materials"
            className="pl-9"
          />
        </div>
        {classes.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {[{ id: ALL_CLASSES, name: "All classes" }, ...classes].map(
              (cls) => (
                <button
                  key={cls.id}
                  type="button"
                  onClick={() => setClassId(cls.id)}
                  aria-pressed={classId === cls.id}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    classId === cls.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  {cls.name}
                </button>
              ),
            )}
          </div>
        )}
      </div>

      {visible.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No materials match that search.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {visible.map((material) => (
            <Card
              key={material.id}
              className="transition-shadow hover:shadow-md"
            >
              <Link
                href={`/student/materials/${material.id}`}
                className="flex items-center gap-4 p-5"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <FileText aria-hidden className="size-5 text-primary" />
                </span>
                <span className="min-w-0 flex-1 space-y-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">
                      {displayName(material)}
                    </span>
                    {material.topic && (
                      <Badge variant="secondary">{material.topic.name}</Badge>
                    )}
                  </span>
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      {material.classes.map((c) => c.name).join(", ")}
                    </span>
                    <span>
                      {material.totalPages} page
                      {material.totalPages !== 1 ? "s" : ""}
                    </span>
                    <span>
                      {(material.sizeBytes / 1024 / 1024).toFixed(2)} MB
                    </span>
                    <span>Shared {formatDate(material.createdAt)}</span>
                  </span>
                </span>
                <ChevronRight
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground"
                />
              </Link>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
