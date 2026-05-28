"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Loader2 } from "lucide-react";

interface MaterialDeleteButtonProps {
  classId: string;
  materialId: string;
}

export default function MaterialDeleteButton({ classId, materialId }: MaterialDeleteButtonProps) {
  const { refresh } = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm("Are you sure you want to terminate/delete this job and its material?")) return;

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
      alert("An error occurred while deleting the material.");
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
