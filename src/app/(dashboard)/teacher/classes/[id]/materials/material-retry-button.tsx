"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { RotateCcw, Loader2 } from "lucide-react";
import { useConfirm, useAlert } from "@/components/ui/confirm-dialog";

interface MaterialRetryButtonProps {
  classId: string;
  materialId: string;
}

export default function MaterialRetryButton({
  classId,
  materialId,
}: MaterialRetryButtonProps) {
  const { refresh } = useRouter();
  const confirm = useConfirm();
  const alert = useAlert();
  const [isRetrying, setIsRetrying] = useState(false);
  // See material-delete-button: the confirm dialog is awaited before
  // `isRetrying` is set, so the ref is what actually blocks a double click.
  const inFlight = useRef(false);

  const handleRetry = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const ok = await confirm({
        title: "Retry processing this material?",
        confirmText: "Retry",
      });
      if (!ok) return;

      setIsRetrying(true);
      try {
        const res = await fetch(
          `/api/classes/${classId}/materials/${materialId}/retry`,
          {
            method: "POST",
          },
        );

        if (!res.ok) {
          throw new Error("Failed to retry material");
        }

        refresh();
      } catch (err) {
        console.error(err);
        await alert("An error occurred while retrying the material.");
      } finally {
        setIsRetrying(false);
      }
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <button
      type="button"
      onClick={handleRetry}
      disabled={isRetrying}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors disabled:opacity-50"
      title="Retry failed processing"
    >
      {isRetrying ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <RotateCcw className="size-3.5" />
      )}
      Retry
    </button>
  );
}
