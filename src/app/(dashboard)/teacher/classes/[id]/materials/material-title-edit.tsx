"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Check, X, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";

interface MaterialTitleEditProps {
  classId: string;
  materialId: string;
  title: string | null;
  originalName: string;
  className?: string;
}

export default function MaterialTitleEdit({
  classId,
  materialId,
  title,
  originalName,
  className,
}: MaterialTitleEditProps) {
  const { refresh } = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title ?? originalName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const displayName = title || originalName;

  function startEdit() {
    setValue(title ?? originalName);
    setError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
  }

  async function save() {
    const trimmed = value.trim();
    if (trimmed === (title ?? "")) {
      setEditing(false);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/classes/${classId}/materials/${materialId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: trimmed }),
        },
      );

      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "Failed to save");
      }

      setEditing(false);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      cancelEdit();
    }
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        <span className={className}>{displayName}</span>
        <button
          type="button"
          onClick={startEdit}
          title="Rename"
          className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors"
        >
          <Pencil className="size-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="flex items-center gap-1">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={saving}
          className={`h-7 py-0 px-2 text-sm ${className ?? ""}`}
        />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          title="Save"
          className="shrink-0 p-0.5 text-primary hover:text-primary/80 rounded transition-colors disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
        </button>
        <button
          type="button"
          onClick={cancelEdit}
          disabled={saving}
          title="Cancel"
          className="shrink-0 p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors disabled:opacity-50"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}
