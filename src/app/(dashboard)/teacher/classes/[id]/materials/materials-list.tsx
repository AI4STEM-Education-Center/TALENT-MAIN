"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FileText, Clock, AlertTriangle, CheckCircle, Plus, Tags } from "lucide-react";
import MaterialDeleteButton from "./material-delete-button";
import MaterialRetryButton from "./material-retry-button";
import MaterialTitleEdit from "./material-title-edit";
import { AiMetricsLine } from "@/components/ai-metrics-line";
import { PoolSubmissionDialog } from "@/components/pool-submission-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface MaterialTag { id: string; name: string }

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
  topic: MaterialTag | null;
  isImported?: boolean;
  // AI generation metrics from the VLM processing run (teacher/admin only).
  aiModel?: string | null;
  aiProvider?: string | null;
  aiServiceTier?: string | null;
  aiThinkingLevel?: string | null;
  aiTtftMs?: number | null;
  aiTokens?: number | null;
  aiTotalMs?: number | null;
}

interface MaterialsListProps {
  classId: string;
  initialMaterials: MaterialItem[];
  initialTags: MaterialTag[];
}

const POLL_INTERVAL_MS = 2000;

function hasActiveProcessing(items: MaterialItem[]): boolean {
  return items.some(
    (m) =>
      (m.processingStatus === "PROCESSING" || m.processingStatus === "IDLE") &&
      m.uploadStatus === "READY"
  );
}

export default function MaterialsList({ classId, initialMaterials, initialTags }: MaterialsListProps) {
  const [materials, setMaterials] = useState<MaterialItem[]>(initialMaterials);
  const [tags, setTags] = useState<MaterialTag[]>(initialTags);
  const [newTag, setNewTag] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
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

  async function createTag() {
    if (!newTag.trim()) return;
    setTagError(null);
    const response = await fetch("/api/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newTag.trim(), contentType: "MATERIAL" }),
    });
    if (!response.ok) {
      setTagError("Could not create the material tag.");
      return;
    }
    const tag = await response.json();
    setTags((current) => [...current, tag]);
    setNewTag("");
  }

  async function assignTag(materialId: string, topicId: string) {
    setTagError(null);
    const response = await fetch(`/api/classes/${classId}/materials/${materialId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId: topicId || null }),
    });
    if (!response.ok) {
      setTagError("Could not tag the material.");
      return;
    }
    const { material } = await response.json();
    setMaterials((current) => current.map((item) => item.id === materialId ? { ...item, topic: material.topic } : item));
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Tags className="size-4" />
          <h3 className="font-medium">Material tags</h3>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={newTag}
            onChange={(event) => setNewTag(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && createTag()}
            placeholder="New material tag"
          />
          <Button variant="outline" onClick={createTag} disabled={!newTag.trim()}>
            <Plus className="size-4" /> Create new tag
          </Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">Material tags are separate from your quiz tags.</p>
        {tagError && <p className="mt-2 text-sm text-destructive">{tagError}</p>}
      </div>
      {materials.length === 0 ? (
        <div className="bg-white border rounded-lg p-10 text-center">
          <p className="text-gray-500">No materials uploaded yet.</p>
        </div>
      ) : materials.map((mat) => {
        const isProcessing =
          mat.processingStatus === "PROCESSING" || mat.processingStatus === "IDLE";
        const progress =
          mat.totalPages > 0 ? (mat.processedPages / mat.totalPages) * 100 : 0;

        return (
          <div
            key={mat.id}
            className="bg-white border rounded-lg p-5 flex items-center justify-between shadow-xs"
          >
            <div className="flex items-center gap-x-4">
              <div className="p-3 bg-blue-50 rounded-full">
                <FileText className="size-6 text-blue-600" />
              </div>
              <div>
                <div className="flex items-center gap-x-2">
                  <MaterialTitleEdit
                    classId={classId}
                    materialId={mat.id}
                    title={mat.title}
                    originalName={mat.originalName}
                    className="text-lg font-medium text-gray-900"
                  />
                  {mat.isImported && (
                    <span className="inline-flex items-center rounded-full bg-purple-50 px-2 py-0.5 text-xs font-medium text-purple-700">
                      Imported
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-x-2 text-sm text-gray-500 mt-1">
                  <span>{(mat.sizeBytes / 1024 / 1024).toFixed(2)} MB</span>
                  <span>•</span>
                  <span>{mat.totalPages} Pages</span>
                  <span>•</span>
                  <span>{new Date(mat.createdAt).toLocaleDateString()}</span>
                </div>
                <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
                  <Tags className="size-4" />
                  <span>Tag existing material</span>
                  <select
                    className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground"
                    value={mat.topic?.id ?? ""}
                    onChange={(event) => assignTag(mat.id, event.target.value)}
                  >
                    <option value="">No tag</option>
                    {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                  </select>
                </label>
              </div>
            </div>

            <div className="flex flex-col items-end w-64">
              {mat.processingStatus === "SUCCESS" && (
                <div className="flex flex-col items-end">
                  <div className="flex items-center text-green-600 font-medium text-sm">
                    <CheckCircle className="size-4 mr-1" /> Ready
                  </div>
                  <AiMetricsLine
                    metrics={{
                      model: mat.aiModel,
                      provider: mat.aiProvider,
                      serviceTier: mat.aiServiceTier,
                      thinkingLevel: mat.aiThinkingLevel,
                      ttftMs: mat.aiTtftMs,
                      totalMs: mat.aiTotalMs,
                      tokens: mat.aiTokens,
                    }}
                    className="mt-0.5 text-xs text-gray-400 text-right"
                  />
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
                {mat.processingStatus === "SUCCESS" && (
                  <PoolSubmissionDialog
                    contentType="MATERIAL"
                    contentId={mat.id}
                    contentName={mat.title || mat.originalName}
                  />
                )}
                {mat.processingStatus === "FAILED" && (
                  <MaterialRetryButton classId={classId} materialId={mat.id} />
                )}
                <MaterialDeleteButton classId={classId} materialId={mat.id} isImported={mat.isImported} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
