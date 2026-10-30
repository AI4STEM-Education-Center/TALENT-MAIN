"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm-dialog";

/** Admin-only: permanently remove a session recording and its chunks. */
export function DeleteRecordingButton({
  recordingId,
}: {
  recordingId: string;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    const ok = await confirm({
      title: "Delete this recording?",
      description:
        "The replay and its timeline are removed permanently. This cannot be undone.",
      confirmText: "Delete recording",
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/session-recordings/${recordingId}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Could not delete the recording.");
      router.push("/admin/session-replays");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete.");
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={busy}
        onClick={remove}
      >
        {busy ? "Deleting…" : "Delete recording"}
      </Button>
      {error && <span className="text-sm text-destructive">{error}</span>}
    </div>
  );
}
