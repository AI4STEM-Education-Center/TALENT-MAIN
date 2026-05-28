"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

type MaterialDeleteButtonProps = {
  id: string;
  label: string;
};

export function MaterialDeleteButton({ id, label }: MaterialDeleteButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onDelete() {
    const confirmed = window.confirm(`Delete "${label}"? This removes the database record and its S3 object.`);
    if (!confirmed) return;

    setBusy(true);
    setError("");
    try {
      const res = await fetch(`/api/learning-materials/${id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "Delete failed.");
        return;
      }

      router.refresh();
    } catch {
      setError("Delete failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="outline" size="sm" onClick={onDelete} disabled={busy}>
        <Trash2 className="w-4 h-4" />
        {busy ? "Deleting…" : "Delete"}
      </Button>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
