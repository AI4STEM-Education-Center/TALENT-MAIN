"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { AiMetricsLine } from "@/components/ai-metrics-line";
import {
  Folder,
  FolderOpen,
  FileText,
  ChevronRight,
  ArrowLeft,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  RotateCcw,
  Trash2,
} from "lucide-react";

interface Material {
  id: string;
  title: string;
  originalName: string;
  processingStatus: string;
  processedPages: number;
  totalPages: number | null;
  errorMessage: string | null;
  aiModel: string | null;
  aiProvider: string | null;
  aiServiceTier: string | null;
  aiThinkingLevel: string | null;
  aiTtftMs: number | null;
  aiTokens: number | null;
  aiTotalMs: number | null;
  teacher: {
    user: {
      username: string;
      firstName: string;
      lastName: string;
      email: string;
    };
  };
  class: {
    name: string;
  };
}

interface TeacherGroup {
  username: string;
  displayName: string;
  classes: Record<string, Material[]>;
}

function groupMaterials(materials: Material[]): Record<string, TeacherGroup> {
  const groups: Record<string, TeacherGroup> = {};
  for (const mat of materials) {
    const username = mat.teacher?.user?.username ?? "unknown";
    const firstName = mat.teacher?.user?.firstName ?? "";
    const lastName = mat.teacher?.user?.lastName ?? "";
    const displayName = firstName || lastName ? `${firstName} ${lastName}`.trim() : username;
    const className = mat.class?.name ?? "Unknown Class";
    if (!groups[username]) {
      groups[username] = { username, displayName, classes: {} };
    }
    if (!groups[username].classes[className]) {
      groups[username].classes[className] = [];
    }
    groups[username].classes[className].push(mat);
  }
  return groups;
}

function totalMaterialCount(group: TeacherGroup): number {
  return Object.values(group.classes).reduce((sum, mats) => sum + mats.length, 0);
}

export default function AdminMaterialsPage() {
  const confirm = useConfirm();
  const [materials, setMaterials] = useState<Material[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTeacher, setSelectedTeacher] = useState<string | null>(null);
  const [selectedClass, setSelectedClass] = useState<string | null>(null);

  const fetchMaterials = async () => {
    try {
      const res = await fetch("/api/admin/materials", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setMaterials(data.materials);
      }
    } catch (err) {
      console.error("Failed to fetch materials", err);
    }
  };

  useEffect(() => {
    fetchMaterials().then(() => setLoading(false));
  }, []);

  const currentClassMaterials =
    selectedTeacher && selectedClass
      ? (groupMaterials(materials)[selectedTeacher]?.classes[selectedClass] ?? [])
      : [];

  useEffect(() => {
    if (!selectedTeacher || !selectedClass) return;
    const hasActive = currentClassMaterials.some(
      (m) => m.processingStatus === "PROCESSING" || m.processingStatus === "IDLE"
    );
    if (!hasActive) return;
    const interval = setInterval(fetchMaterials, 2000);
    return () => clearInterval(interval);
  }, [selectedTeacher, selectedClass, currentClassMaterials]);

  const handleRetry = async (materialId: string) => {
    try {
      await fetch(`/api/admin/materials/${materialId}/retry`, { method: "POST" });
      fetchMaterials();
    } catch (err) {
      console.error(err);
    }
  };

  const handleRegenerate = async (materialId: string) => {
    const ok = await confirm({
      title: "Re-process this material?",
      description: "This will fully re-process all pages from scratch.",
      confirmText: "Re-process",
    });
    if (!ok) return;
    try {
      await fetch(`/api/admin/materials/${materialId}/regenerate`, { method: "POST" });
      fetchMaterials();
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async (materialId: string) => {
    const ok = await confirm({
      title: "Delete this material?",
      description: "This permanently deletes the material and all of its files. This cannot be undone.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await fetch(`/api/admin/materials/${materialId}`, { method: "DELETE" });
      fetchMaterials();
    } catch (err) {
      console.error(err);
    }
  };

  const groups = groupMaterials(materials);

  const teacherDisplayName = selectedTeacher ? (groups[selectedTeacher]?.displayName ?? selectedTeacher) : null;

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">Materials Processing</h1>
        <p className="text-muted-foreground mt-1">
          Browse and manage uploaded materials by teacher and class.
        </p>
      </div>

      <nav className="flex items-center gap-1 text-sm mb-8 text-muted-foreground">
        <button
          type="button"
          onClick={() => { setSelectedTeacher(null); setSelectedClass(null); }}
          className={selectedTeacher ? "hover:text-foreground transition-colors" : "text-foreground font-medium cursor-default"}
        >
          Materials
        </button>
        {selectedTeacher && (
          <>
            <ChevronRight className="size-3.5 shrink-0" />
            <button
              type="button"
              onClick={() => setSelectedClass(null)}
              className={selectedClass ? "hover:text-foreground transition-colors" : "text-foreground font-medium cursor-default"}
            >
              {teacherDisplayName}
            </button>
          </>
        )}
        {selectedClass && (
          <>
            <ChevronRight className="size-3.5 shrink-0" />
            <span className="text-foreground font-medium">{selectedClass}</span>
          </>
        )}
      </nav>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[...Array(3)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="pb-2">
                <div className="h-4 w-32 bg-muted rounded" />
              </CardHeader>
              <CardContent>
                <div className="h-4 w-20 bg-muted rounded mt-2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !selectedTeacher ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Object.keys(groups).length === 0 ? (
            <p className="text-muted-foreground col-span-full">No materials found.</p>
          ) : (
            Object.values(groups).map((group) => (
              <button
                key={group.username}
                type="button"
                onClick={() => setSelectedTeacher(group.username)}
                className="text-left h-full"
              >
                <Card className="hover:bg-accent/50 transition-colors cursor-pointer h-full">
                  <CardHeader className="flex flex-row items-center gap-3 gap-y-0 pb-2">
                    <Folder className="size-5 text-blue-500 shrink-0" />
                    <CardTitle className="text-base font-semibold">
                      {group.displayName === group.username
                        ? group.username
                        : `${group.displayName} (${group.username})`}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">
                      {totalMaterialCount(group)} material{totalMaterialCount(group) !== 1 ? "s" : ""} across {Object.keys(group.classes).length} class{Object.keys(group.classes).length !== 1 ? "es" : ""}
                    </p>
                  </CardContent>
                </Card>
              </button>
            ))
          )}
        </div>
      ) : !selectedClass ? (
        <>
          <button
            type="button"
            onClick={() => setSelectedTeacher(null)}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            <ArrowLeft className="size-4" />
            Back to teachers
          </button>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Object.keys(groups[selectedTeacher]?.classes ?? {}).length === 0 ? (
              <p className="text-muted-foreground col-span-full">No classes found.</p>
            ) : (
              Object.entries(groups[selectedTeacher].classes).map(([className, mats]) => (
                <button
                  key={className}
                  type="button"
                  onClick={() => setSelectedClass(className)}
                  className="text-left h-full"
                >
                  <Card className="hover:bg-accent/50 transition-colors cursor-pointer h-full">
                    <CardHeader className="flex flex-row items-center gap-3 gap-y-0 pb-2">
                      <FolderOpen className="size-5 text-amber-500 shrink-0" />
                      <CardTitle className="text-base font-semibold">{className}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        {mats.length} material{mats.length !== 1 ? "s" : ""}
                      </p>
                    </CardContent>
                  </Card>
                </button>
              ))
            )}
          </div>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setSelectedClass(null)}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            <ArrowLeft className="size-4" />
            Back to classes
          </button>
          <div className="bg-white border rounded-lg overflow-hidden shadow-xs">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Document</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Progress</th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {currentClassMaterials.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-4 text-center text-sm text-gray-500">No materials found.</td>
                  </tr>
                ) : (
                  currentClassMaterials.map((mat) => (
                    <tr key={mat.id}>
                      <td className="px-6 py-4 text-sm font-medium text-gray-900">
                        <Link href={`/admin/materials/${mat.id}`} className="flex items-center gap-2 hover:text-blue-600 hover:underline">
                          <FileText className="size-4 text-gray-400 shrink-0" />
                          {mat.title || mat.originalName}
                        </Link>
                        {mat.processingStatus === "SUCCESS" && (
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
                            className="mt-1 block whitespace-normal text-xs font-normal text-gray-400"
                          />
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {mat.processingStatus === "SUCCESS" && (
                          <span className="inline-flex items-center text-green-600">
                            <CheckCircle className="size-4 mr-1" /> Success
                          </span>
                        )}
                        {mat.processingStatus === "FAILED" && (
                          <span className="inline-flex items-center text-red-600" title={mat.errorMessage ?? undefined}>
                            <AlertTriangle className="size-4 mr-1" /> Failed
                          </span>
                        )}
                        {mat.processingStatus === "PROCESSING" && (
                          <span className="inline-flex items-center text-blue-600">
                            <RefreshCw className="size-4 mr-1 animate-spin" /> Processing
                          </span>
                        )}
                        {mat.processingStatus === "IDLE" && (
                          <span className="inline-flex items-center text-gray-500">Idle</span>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {mat.processedPages} / {mat.totalPages ?? "?"}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end gap-2">
                          {mat.processingStatus === "FAILED" && (
                            <button
                              type="button"
                              onClick={() => handleRetry(mat.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md transition-colors"
                              title="Retry failed pages"
                            >
                              <RotateCcw className="size-3" /> Retry
                            </button>
                          )}
                          {mat.processingStatus !== "PROCESSING" && (
                            <button
                              type="button"
                              onClick={() => handleRegenerate(mat.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-orange-700 bg-orange-50 hover:bg-orange-100 rounded-md transition-colors"
                              title="Re-process all pages from scratch"
                            >
                              <RefreshCw className="size-3" /> Regenerate
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleDelete(mat.id)}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            title="Delete material"
                          >
                            <Trash2 className="size-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
