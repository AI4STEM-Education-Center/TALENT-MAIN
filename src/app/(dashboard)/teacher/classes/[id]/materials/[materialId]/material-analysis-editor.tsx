"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Check, Loader2, Save } from "lucide-react";
import PageViewer from "./page-viewer";

interface MaterialPageData {
  id: string;
  pageNumber: number;
  keyConcept: string | null;
  description: string | null;
  needed: boolean | null;
}

interface MaterialAnalysisEditorProps {
  classId: string;
  materialId: string;
  processingStatus: string;
  batchDescription: string | null;
  batchKeyConcepts: string;
  pages: MaterialPageData[];
}

interface PageState {
  id: string;
  pageNumber: number;
  keyConcept: string;
  description: string;
  needed: boolean;
  saving: boolean;
  error: string | null;
  savedAt: number | null;
  original: {
    keyConcept: string;
    description: string;
    needed: boolean;
  };
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").trim();
}

export default function MaterialAnalysisEditor({
  classId,
  materialId,
  processingStatus,
  batchDescription,
  batchKeyConcepts,
  pages,
}: MaterialAnalysisEditorProps) {
  const [summary, setSummary] = useState(batchDescription ?? "");
  const [summaryOriginal, setSummaryOriginal] = useState(batchDescription ?? "");
  const [summarySaving, setSummarySaving] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summarySavedAt, setSummarySavedAt] = useState<number | null>(null);

  const [pageStates, setPageStates] = useState<PageState[]>(() =>
    pages.map((page) => {
      const keyConcept = page.keyConcept ?? "";
      const description = page.description ?? "";
      const needed = page.needed ?? false;
      return {
        id: page.id,
        pageNumber: page.pageNumber,
        keyConcept,
        description,
        needed,
        saving: false,
        error: null,
        savedAt: null,
        original: {
          keyConcept,
          description,
          needed,
        },
      };
    })
  );

  const keyConcepts = useMemo(() => {
    try {
      const parsed = JSON.parse(batchKeyConcepts || "[]");
      return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
    } catch {
      return [] as string[];
    }
  }, [batchKeyConcepts]);

  const coreCount = useMemo(
    () => pageStates.filter((page) => page.needed).length,
    [pageStates]
  );

  const summaryDirty = normalizeText(summary) !== normalizeText(summaryOriginal);

  const updatePageField = (pageId: string, field: "keyConcept" | "description" | "needed", value: string | boolean) => {
    setPageStates((prev) =>
      prev.map((page) =>
        page.id === pageId
          ? {
              ...page,
              [field]: value,
              savedAt: null,
              error: null,
            }
          : page
      )
    );
  };

  const resetPage = (pageId: string) => {
    setPageStates((prev) =>
      prev.map((page) =>
        page.id === pageId
          ? {
              ...page,
              keyConcept: page.original.keyConcept,
              description: page.original.description,
              needed: page.original.needed,
              error: null,
              savedAt: null,
            }
          : page
      )
    );
  };

  const saveSummary = async () => {
    if (!summaryDirty || summarySaving) return;
    setSummarySaving(true);
    setSummaryError(null);

    try {
      const res = await fetch(`/api/classes/${classId}/materials/${materialId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchDescription: summary }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update summary");
      }

      const data = await res.json();
      const updatedSummary = data.material?.batchDescription ?? summary;
      const normalizedSummary = updatedSummary ?? "";
      setSummary(normalizedSummary);
      setSummaryOriginal(normalizedSummary);
      setSummarySavedAt(Date.now());
    } catch (err: any) {
      setSummaryError(err.message || "Failed to update summary");
    } finally {
      setSummarySaving(false);
    }
  };

  const savePage = async (pageId: string) => {
    const page = pageStates.find((item) => item.id === pageId);
    if (!page || page.saving) return;

    const isDirty =
      normalizeText(page.keyConcept) !== normalizeText(page.original.keyConcept) ||
      normalizeText(page.description) !== normalizeText(page.original.description) ||
      page.needed !== page.original.needed;

    if (!isDirty) return;

    setPageStates((prev) =>
      prev.map((item) =>
        item.id === pageId
          ? {
              ...item,
              saving: true,
              error: null,
            }
          : item
      )
    );

    try {
      const res = await fetch(`/api/classes/${classId}/materials/${materialId}/pages/${pageId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          needed: page.needed,
          keyConcept: page.keyConcept,
          description: page.description,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update page");
      }

      const data = await res.json();
      const updated = data.page || {};
      const updatedKeyConcept = updated.keyConcept ?? "";
      const updatedDescription = updated.description ?? "";
      const updatedNeeded = typeof updated.needed === "boolean" ? updated.needed : page.needed;

      setPageStates((prev) =>
        prev.map((item) =>
          item.id === pageId
            ? {
                ...item,
                keyConcept: updatedKeyConcept,
                description: updatedDescription,
                needed: updatedNeeded,
                saving: false,
                error: null,
                savedAt: Date.now(),
                original: {
                  keyConcept: updatedKeyConcept,
                  description: updatedDescription,
                  needed: updatedNeeded,
                },
              }
            : item
        )
      );
    } catch (err: any) {
      setPageStates((prev) =>
        prev.map((item) =>
          item.id === pageId
            ? {
                ...item,
                saving: false,
                error: err.message || "Failed to update page",
              }
            : item
        )
      );
    }
  };

  return (
    <div className="space-y-8">
      {processingStatus === "SUCCESS" && (
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-6">
          <div className="flex items-center gap-x-3 mb-4">
            <Save className="size-5 text-blue-600" />
            <h2 className="text-xl font-semibold text-blue-900">Document Summary</h2>
          </div>
          <div className="space-y-3">
            <Textarea
              value={summary}
              onChange={(e) => {
                setSummary(e.target.value);
                setSummaryError(null);
                setSummarySavedAt(null);
              }}
              placeholder="Summarize the document for students."
              className="bg-white border-blue-100"
              rows={4}
              disabled={summarySaving}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={saveSummary} disabled={!summaryDirty || summarySaving}>
                {summarySaving ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Saving
                  </>
                ) : (
                  <>Save summary</>
                )}
              </Button>
              {summarySavedAt && (
                <span className="text-sm text-blue-700 flex items-center gap-1">
                  <Check className="size-4" /> Saved
                </span>
              )}
              {summaryError && <span className="text-sm text-red-600">{summaryError}</span>}
            </div>
          </div>

          {keyConcepts.length > 0 && (
            <div className="mt-6">
              <h3 className="text-sm font-semibold text-blue-900 uppercase tracking-wider mb-3">
                Key Concepts
              </h3>
              <div className="flex flex-wrap gap-2">
                {keyConcepts.map((concept, idx) => (
                  <span
                    key={`${concept}-${idx}`}
                    className="px-3 py-1 bg-white text-blue-700 rounded-full text-sm font-medium shadow-xs border border-blue-200"
                  >
                    {concept}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-6">
        <div className="flex items-end justify-between border-b pb-2">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">All Pages</h2>
            <p className="text-sm text-gray-500">{coreCount} marked as core content.</p>
          </div>
        </div>

        {pageStates.length === 0 ? (
          <p className="text-gray-500 italic">No pages found.</p>
        ) : (
          <div className="grid gap-8">
            {pageStates.map((page) => {
              const isDirty =
                normalizeText(page.keyConcept) !== normalizeText(page.original.keyConcept) ||
                normalizeText(page.description) !== normalizeText(page.original.description) ||
                page.needed !== page.original.needed;

              return (
                <div key={page.id} className="bg-white border rounded-xl overflow-hidden shadow-xs">
                  <div className="flex flex-col md:flex-row">
                    <div className="md:w-1/3 bg-gray-100 flex items-center justify-center p-4 border-b md:border-b-0 md:border-r border-gray-200">
                      <PageViewer classId={classId} materialId={materialId} pageId={page.id} />
                    </div>
                    <div className="p-6 md:w-2/3 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                          Page {page.pageNumber}
                        </span>
                        <label className="flex items-center gap-2 text-sm text-gray-700">
                          <input
                            type="checkbox"
                            checked={page.needed}
                            onChange={(e) => updatePageField(page.id, "needed", e.target.checked)}
                            className="size-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                            disabled={page.saving}
                          />
                          Core content
                        </label>
                      </div>

                      <div>
                        <label htmlFor={`key-concept-${page.id}`} className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                          Key concept
                        </label>
                        <Input
                          id={`key-concept-${page.id}`}
                          value={page.keyConcept}
                          onChange={(e) => updatePageField(page.id, "keyConcept", e.target.value)}
                          placeholder="Short key concept"
                          className="mt-2"
                          disabled={page.saving}
                        />
                      </div>

                      <div>
                        <label htmlFor={`description-${page.id}`} className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                          Description
                        </label>
                        <Textarea
                          id={`description-${page.id}`}
                          value={page.description}
                          onChange={(e) => updatePageField(page.id, "description", e.target.value)}
                          placeholder="Describe what students should learn from this page."
                          className="mt-2"
                          rows={4}
                          disabled={page.saving}
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-3">
                        <Button onClick={() => savePage(page.id)} disabled={!isDirty || page.saving}>
                          {page.saving ? (
                            <>
                              <Loader2 className="size-4 animate-spin" /> Saving
                            </>
                          ) : (
                            <>Save page</>
                          )}
                        </Button>
                        <Button variant="ghost" onClick={() => resetPage(page.id)} disabled={!isDirty || page.saving}>
                          Reset
                        </Button>
                        {page.savedAt && (
                          <span className="text-sm text-green-600 flex items-center gap-1">
                            <Check className="size-4" /> Saved
                          </span>
                        )}
                        {page.error && <span className="text-sm text-red-600">{page.error}</span>}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
