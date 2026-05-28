"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileText, Clock, AlertTriangle, CheckCircle } from "lucide-react";
import MaterialDeleteButton from "./material-delete-button";
import MaterialRetryButton from "./material-retry-button";
import MaterialTitleEdit from "./material-title-edit";

export interface MaterialItem {
  id: string;
  title: string | null;
  originalName: string;
  sizeBytes: number;
  totalPages: number;
  processedPages: number;
  uploadStatus: string;
  processingStatus: string;
  errorMessage: string | null;
  createdAt: string | Date;
}

interface MaterialsListProps {
  classId: string;
  initialMaterials: MaterialItem[];
}

const POLL_INTERVAL_MS = 2000;

function hasActiveProcessing(items: MaterialItem[]): boolean {
  return items.some(
    (m) =>
      (m.processingStatus === "PROCESSING" || m.processingStatus === "IDLE") &&
      m.uploadStatus === "READY"
  );
}

export default function MaterialsList({ classId, initialMaterials }: MaterialsListProps) {
  const [materials, setMaterials] = useState<MaterialItem[]>(initialMaterials);
  const lastInitialRef = useRef(initialMaterials);

  // Sync from server when parent re-renders with new data (after a mutation/refresh).
  useEffect(() => {
    if (lastInitialRef.current !== initialMaterials) {
      lastInitialRef.current = initialMaterials;
      setMaterials(initialMaterials);
    }
  }, [initialMaterials]);

  // Poll every 2s while any material is still processing.
  useEffect(() => {
    if (!hasActiveProcessing(materials)) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/classes/${classId}/materials`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.materials)) {
          setMaterials(data.materials);
        }
      } catch {
        // Swallow transient errors; next tick will retry.
      }
    };

    const interval = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [materials, classId]);

  if (materials.length === 0) {
    return (
      <div className="bg-white border rounded-lg p-10 text-center">
        <p className="text-gray-500">No materials uploaded yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {materials.map((mat) => {
        const isProcessing =
          mat.processingStatus === "PROCESSING" || mat.processingStatus === "IDLE";
        const progress =
          mat.totalPages > 0 ? (mat.processedPages / mat.totalPages) * 100 : 0;

        return (
          <div
            key={mat.id}
            className="bg-white border rounded-lg p-5 flex items-center justify-between shadow-sm"
          >
            <div className="flex items-center gap-x-4">
              <div className="p-3 bg-blue-50 rounded-full">
                <FileText className="size-6 text-blue-600" />
              </div>
              <div>
                <MaterialTitleEdit
                  classId={classId}
                  materialId={mat.id}
                  title={mat.title}
                  originalName={mat.originalName}
                  className="text-lg font-medium text-gray-900"
                />
                <div className="flex items-center gap-x-2 text-sm text-gray-500 mt-1">
                  <span>{(mat.sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
                  <span>•</span>
                  <span>{mat.totalPages} Pages</span>
                  <span>•</span>
                  <span>{new Date(mat.createdAt).toLocaleDateString()}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-col items-end w-64">
              {mat.processingStatus === "SUCCESS" && (
                <div className="flex items-center text-green-600 font-medium text-sm">
                  <CheckCircle className="size-4 mr-1" /> Ready
                </div>
              )}
              {mat.processingStatus === "FAILED" && (
                <div
                  className="flex items-center text-red-600 font-medium text-sm"
                  title={mat.errorMessage || "Error"}
                >
                  <AlertTriangle className="size-4 mr-1" /> Processing Failed
                </div>
              )}
              {isProcessing && mat.uploadStatus === "READY" && (
                <div className="w-full">
                  <div className="flex justify-between text-xs text-blue-600 mb-1 font-medium">
                    <span className="flex items-center">
                      <Clock className="size-3 mr-1" /> Analyzing…
                    </span>
                    <span>{Math.round(progress)}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                      style={{ width: `${progress}%` }}
                    ></div>
                  </div>
                </div>
              )}
              {mat.uploadStatus === "PENDING" && (
                <span className="text-sm text-gray-500 italic">Upload interrupted</span>
              )}

              {mat.processingStatus === "SUCCESS" && (
                <Link
                  href={`/teacher/classes/${classId}/materials/${mat.id}`}
                  className="mt-3 px-4 py-2 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-md text-sm font-medium transition-colors"
                >
                  View Analysis
                </Link>
              )}
              <div className="mt-3 flex items-center">
                {mat.processingStatus === "FAILED" && (
                  <MaterialRetryButton classId={classId} materialId={mat.id} />
                )}
                <MaterialDeleteButton classId={classId} materialId={mat.id} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
