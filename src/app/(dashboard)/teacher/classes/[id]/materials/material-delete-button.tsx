"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";
import { useConfirm, useAlert } from "@/components/ui/confirm-dialog";

interface MaterialDeleteButtonProps {
  classId: string;
  materialId: string;
  isImported?: boolean;
}

export default function MaterialDeleteButton({ classId, materialId, isImported }: MaterialDeleteButtonProps) {
  const { refresh } = useRouter();
  const confirm = useConfirm();
  const alert = useAlert();
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    const description = isImported
      ? "It stays in your other classes; the file is permanently deleted only if no other class uses it."
      : "The file is permanently deleted only if no other class uses it.";
    const ok = await confirm({
      title: "Remove this material from this class?",
      description,
      confirmText: "Remove",
      variant: "destructive",
    });
    if (!ok) return;

    setIsDeleting(true);
    try {
      const res = await fetch(`/api/classes/${classId}/materials/${materialId}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        throw new Error("Failed to delete material");
      }

      refresh();
    } catch (err) {
      console.error(err);
      await alert("An error occurred while deleting the material.");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <button type="button"
      onClick={handleDelete}
      disabled={isDeleting}
      className="ml-3 p-2 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
      title="Delete / Terminate Job"
    >
      {isDeleting ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Trash2 className="size-4" />
      )}
    </button>
  );
}
