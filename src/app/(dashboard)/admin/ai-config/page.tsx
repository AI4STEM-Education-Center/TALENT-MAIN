"use client";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronUp,
  Cloud,
  Globe,
  Key,
  Loader2,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings2,
  Trash2,
  Zap,
} from "lucide-react";

// ─── Types ──────────────────────────────────────────────────────────────────────

interface AiModel {
  id: string;
  modelId: string;
  displayName: string | null;
  serviceTier: string | null;
  isDefault: boolean;
}

type ProviderType = "openai" | "local" | "cloudflare";

interface AiProvider {
  id: string;
  name: string;
  providerType: ProviderType;
  baseUrl: string | null;
  hasApiKey: boolean;
  maskedApiKey: string | null;
  cfAigByokAlias: string | null;
  isActive: boolean;
  models: AiModel[];
  assignmentCount: number;
}

interface Assignment {
  id: string;
  providerId: string;
  providerName: string;
  providerType: string;
  providerActive: boolean;
  modelId: string;
  modelIdentifier: string;
  modelDisplayName: string | null;
  serviceTier: string | null;
}

type Assignments = Record<string, Assignment | null>;

interface ProviderForm {
  name: string;
  providerType: ProviderType;
  baseUrl: string;
  apiKey: string;
  cfAigByokAlias: string;
}

interface ModelForm {
  modelId: string;
  displayName: string;
  serviceTier: string;
  isDefault: boolean;
}

// ─── Constants ──────────────────────────────────────────────────────────────────

const USE_CASE_LABELS: Record<string, string> = {
  teacher_chat: "Teacher & Admin Chat",
  student_chat: "Student Chat",
  pdf_description: "PDF Description Generation",
};

const EMPTY_PROVIDER_FORM: ProviderForm = {
  name: "",
  providerType: "openai",
  baseUrl: "",
  apiKey: "",
  cfAigByokAlias: "",
};

const EMPTY_MODEL_FORM: ModelForm = {
  modelId: "",
  displayName: "",
  serviceTier: "",
  isDefault: false,
};

// ─── Component ──────────────────────────────────────────────────────────────────

export default function AiConfigPage() {
  const confirm = useConfirm();
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [assignments, setAssignments] = useState<Assignments>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Provider form state
  const [showProviderForm, setShowProviderForm] = useState(false);
  const [providerForm, setProviderForm] = useState<ProviderForm>(EMPTY_PROVIDER_FORM);
  const [providerSaving, setProviderSaving] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);

  // Expanded provider (for model management)
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null);

  // Model form state
  const [showModelForm, setShowModelForm] = useState<string | null>(null);
  const [modelForm, setModelForm] = useState<ModelForm>(EMPTY_MODEL_FORM);
  const [modelSaving, setModelSaving] = useState(false);
  const [discovering, setDiscovering] = useState<string | null>(null);

  // Discover modal state
  const [discoverModal, setDiscoverModal] = useState<{
    providerId: string;
    providerName: string;
    available: string[];
    existing: Set<string>;
  } | null>(null);
  const [selectedDiscover, setSelectedDiscover] = useState<Set<string>>(new Set());
  const [discoverAdding, setDiscoverAdding] = useState(false);

  // Edit-model modal state
  const [editingModel, setEditingModel] = useState<{
    providerId: string;
    id: string;
  } | null>(null);
  const [editModelForm, setEditModelForm] = useState<ModelForm>(EMPTY_MODEL_FORM);
  const [editModelSaving, setEditModelSaving] = useState(false);

  // Assignment state
  const [assignmentEdits, setAssignmentEdits] = useState<
    Record<string, { providerId: string; modelId: string }>
  >({});
  const [assignmentSaving, setAssignmentSaving] = useState(false);

  // Test state
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; message: string; loading: boolean }>
  >({});

  // ─── Data Fetching ──────────────────────────────────────────────────────────

  const fetchProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/ai-providers");
      if (!res.ok) throw new Error("Failed to load providers");
      const data = await res.json();
      setProviders(data.providers);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  const fetchAssignments = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/ai-assignments");
      if (!res.ok) throw new Error("Failed to load assignments");
      const data = await res.json();
      setAssignments(data.assignments);
    } catch (err: any) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    async function load() {
      setLoading(true);
      await Promise.all([fetchProviders(), fetchAssignments()]);
      setLoading(false);
    }
    load();
  }, [fetchProviders, fetchAssignments]);

  // ─── Provider CRUD ──────────────────────────────────────────────────────────

  const handleProviderSubmit = async () => {
    setProviderSaving(true);
    try {
      const url = editingProviderId
        ? `/api/admin/ai-providers/${editingProviderId}`
        : "/api/admin/ai-providers";
      const method = editingProviderId ? "PATCH" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(providerForm),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save provider");
      }

      setShowProviderForm(false);
      setEditingProviderId(null);
      setProviderForm(EMPTY_PROVIDER_FORM);
      await fetchProviders();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProviderSaving(false);
    }
  };

  const handleEditProvider = (p: AiProvider) => {
    setProviderForm({
      name: p.name,
      providerType: p.providerType,
      baseUrl: p.baseUrl || "",
      apiKey: p.maskedApiKey || "",
      cfAigByokAlias: p.cfAigByokAlias || "",
    });
    setEditingProviderId(p.id);
    setShowProviderForm(true);
  };

  const handleDeleteProvider = async (id: string) => {
    const ok = await confirm({
      title: "Delete this provider?",
      description: "All associated models and assignments will be removed.",
      confirmText: "Delete",
      variant: "destructive",
    });
    if (!ok) return;
    try {
      const res = await fetch(`/api/admin/ai-providers/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete provider");
      await Promise.all([fetchProviders(), fetchAssignments()]);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleToggleActive = async (p: AiProvider) => {
    try {
      const res = await fetch(`/api/admin/ai-providers/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !p.isActive }),
      });
      if (!res.ok) throw new Error("Failed to update provider");
      await fetchProviders();
    } catch (err: any) {
      setError(err.message);
    }
  };

  // ─── Model CRUD ─────────────────────────────────────────────────────────────

  const handleModelSubmit = async (providerId: string) => {
    setModelSaving(true);
    try {
      const res = await fetch(`/api/admin/ai-providers/${providerId}/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(modelForm),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to add model");
      }

      setShowModelForm(null);
      setModelForm(EMPTY_MODEL_FORM);
      await fetchProviders();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setModelSaving(false);
    }
  };

  const handleDeleteModel = async (providerId: string, modelRecordId: string) => {
    try {
      const res = await fetch(`/api/admin/ai-providers/${providerId}/models`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId: modelRecordId }),
      });
      if (!res.ok) throw new Error("Failed to delete model");
      await Promise.all([fetchProviders(), fetchAssignments()]);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDiscover = async (providerId: string) => {
    setDiscovering(providerId);
    setError("");
    try {
      const res = await fetch(
        `/api/admin/ai-providers/${providerId}/models/discover`,
        { method: "POST" }
      );
      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Discovery failed");
      }

      if (data.models && data.models.length > 0) {
        // Open a modal listing the discovered models; the admin chooses which to add.
        const provider = providers.find((p) => p.id === providerId);
        const existing = new Set<string>(
          provider?.models.map((m) => m.modelId) || []
        );
        // Pre-select models that aren't already added.
        const preselected = new Set<string>(
          (data.models as string[]).filter((m) => !existing.has(m))
        );
        setDiscoverModal({
          providerId,
          providerName: provider?.name || "this provider",
          available: data.models,
          existing,
        });
        setSelectedDiscover(preselected);
      } else {
        setError("No models were discovered from this endpoint.");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDiscovering(null);
    }
  };

  const closeDiscoverModal = () => {
    setDiscoverModal(null);
    setSelectedDiscover(new Set());
  };

  const toggleDiscoverModel = (modelId: string) => {
    setSelectedDiscover((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const handleAddSelectedModels = async () => {
    if (!discoverModal) return;
    setDiscoverAdding(true);
    try {
      for (const modelId of selectedDiscover) {
        const res = await fetch(
          `/api/admin/ai-providers/${discoverModal.providerId}/models`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelId, isDefault: false }),
          }
        );
        // 409 means it already exists — safe to ignore.
        if (!res.ok && res.status !== 409) {
          const d = await res.json().catch(() => ({}));
          throw new Error(d.error || `Failed to add "${modelId}"`);
        }
      }
      await fetchProviders();
      closeDiscoverModal();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setDiscoverAdding(false);
    }
  };

  const handleEditModelOpen = (providerId: string, m: AiModel) => {
    setEditModelForm({
      modelId: m.modelId,
      displayName: m.displayName || "",
      serviceTier: m.serviceTier || "",
      isDefault: m.isDefault,
    });
    setEditingModel({ providerId, id: m.id });
  };

  const handleEditModelSubmit = async () => {
    if (!editingModel) return;
    setEditModelSaving(true);
    try {
      const res = await fetch(
        `/api/admin/ai-providers/${editingModel.providerId}/models`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingModel.id, ...editModelForm }),
        }
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update model");
      }
      setEditingModel(null);
      await Promise.all([fetchProviders(), fetchAssignments()]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setEditModelSaving(false);
    }
  };

  // ─── Assignments ────────────────────────────────────────────────────────────

  const handleAssignmentChange = (
    useCase: string,
    field: "providerId" | "modelId",
    value: string
  ) => {
    setAssignmentEdits((prev) => ({
      ...prev,
      [useCase]: {
        ...(prev[useCase] || {
          providerId: assignments[useCase]?.providerId || "",
          modelId: assignments[useCase]?.modelId || "",
        }),
        [field]: value,
        // Reset modelId when provider changes
        ...(field === "providerId" ? { modelId: "" } : {}),
      },
    }));
  };

  const handleSaveAssignments = async () => {
    setAssignmentSaving(true);
    try {
      const payload: Record<string, { providerId: string; modelId: string } | null> = {};

      for (const useCase of Object.keys(USE_CASE_LABELS)) {
        if (useCase in assignmentEdits) {
          const edit = assignmentEdits[useCase];
          if (edit.providerId && edit.modelId) {
            payload[useCase] = edit;
          } else if (!edit.providerId && !edit.modelId) {
            payload[useCase] = null;
          }
        }
      }

      if (Object.keys(payload).length === 0) {
        setAssignmentSaving(false);
        return;
      }

      const res = await fetch("/api/admin/ai-assignments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignments: payload }),
      });

      if (!res.ok) throw new Error("Failed to save assignments");

      setAssignmentEdits({});
      await fetchAssignments();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setAssignmentSaving(false);
    }
  };

  const handleTestConnection = async (useCase: string) => {
    setTestResults((prev) => ({
      ...prev,
      [useCase]: { success: false, message: "", loading: true },
    }));

    try {
      const res = await fetch("/api/admin/ai-assignments/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useCase }),
      });

      const data = await res.json();

      setTestResults((prev) => ({
        ...prev,
        [useCase]: {
          success: data.success,
          message: data.success
            ? `${data.model} responded in ${data.latencyMs}ms: "${data.reply}"`
            : data.error || "Test failed",
          loading: false,
        },
      }));
    } catch (err: any) {
      setTestResults((prev) => ({
        ...prev,
        [useCase]: {
          success: false,
          message: err.message,
          loading: false,
        },
      }));
    }
  };

  // ─── Helpers ────────────────────────────────────────────────────────────────

  const getModelsForProvider = (providerId: string): AiModel[] => {
    return providers.find((p) => p.id === providerId)?.models || [];
  };

  const getEffectiveAssignment = (useCase: string) => {
    if (useCase in assignmentEdits) {
      return assignmentEdits[useCase];
    }
    const existing = assignments[useCase];
    return existing
      ? { providerId: existing.providerId, modelId: existing.modelId }
      : { providerId: "", modelId: "" };
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  const discoverNewModels = discoverModal
    ? discoverModal.available.filter((m) => !discoverModal.existing.has(m))
    : [];
  const allNewSelected =
    discoverNewModels.length > 0 &&
    discoverNewModels.every((m) => selectedDiscover.has(m));

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">AI Configuration</h1>
        <p className="text-muted-foreground mt-1">
          Manage API providers, models, and use-case assignments.
        </p>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{error}</span>
          <button type="button"
            onClick={() => setError("")}
            className="ml-auto text-red-500 hover:text-red-700"
          >
            ×
          </button>
        </div>
      )}

      {/* ─── Section 1: Provider Pool ─────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Server className="size-5" /> Provider Pool
            </h2>
            <p className="text-sm text-muted-foreground">
              Configure API endpoints, keys, and their available models.
            </p>
          </div>
          <button type="button"
            onClick={() => {
              setProviderForm(EMPTY_PROVIDER_FORM);
              setEditingProviderId(null);
              setShowProviderForm(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus className="size-4" /> Add Provider
          </button>
        </div>

        {/* Provider form */}
        {showProviderForm && (
          <Card className="mb-4 border-blue-200 dark:border-blue-900">
            <CardContent className="pt-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label htmlFor="provider-name" className="block text-sm font-medium mb-1">Name</label>
                  <input
                    id="provider-name"
                    type="text"
                    value={providerForm.name}
                    onChange={(e) =>
                      setProviderForm((f) => ({ ...f, name: e.target.value }))
                    }
                    placeholder="e.g. Production OpenAI"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label id="provider-type-label" htmlFor="provider-type" className="block text-sm font-medium mb-1">Type</label>
                  <Select
                    aria-labelledby="provider-type-label"
                    value={providerForm.providerType}
                    onValueChange={(v) =>
                      setProviderForm((f) => ({
                        ...f,
                        providerType: v as ProviderType,
                      }))
                    }
                  >
                    <SelectTrigger id="provider-type" className="h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai">
                        <span className="flex items-center gap-2">
                          <Globe className="size-3.5" /> OpenAI
                        </span>
                      </SelectItem>
                      <SelectItem value="local">
                        <span className="flex items-center gap-2">
                          <Monitor className="size-3.5" /> Local
                        </span>
                      </SelectItem>
                      <SelectItem value="cloudflare">
                        <span className="flex items-center gap-2">
                          <Cloud className="size-3.5" /> Cloudflare AI Gateway
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label htmlFor="provider-url" className="block text-sm font-medium mb-1">
                    Base URL{" "}
                    <span className="text-muted-foreground font-normal">
                      {providerForm.providerType === "openai"
                        ? "(leave empty for default)"
                        : "(required)"}
                    </span>
                  </label>
                  <input
                    id="provider-url"
                    type="url"
                    value={providerForm.baseUrl}
                    onChange={(e) =>
                      setProviderForm((f) => ({ ...f, baseUrl: e.target.value }))
                    }
                    placeholder={
                      providerForm.providerType === "local"
                        ? "http://localhost:11434/v1"
                        : providerForm.providerType === "cloudflare"
                          ? "https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai"
                          : "https://api.openai.com/v1"
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
                  />
                </div>
                <div>
                  <label htmlFor="provider-key" className="block text-sm font-medium mb-1">
                    {providerForm.providerType === "cloudflare" ? "CF_AIG_TOKEN" : "API Key"}{" "}
                    <span className="text-muted-foreground font-normal">
                      {providerForm.providerType === "cloudflare"
                        ? "(required — sent as Authorization: Bearer)"
                        : "(encrypted at rest)"}
                    </span>
                  </label>
                  <input
                    id="provider-key"
                    type="password"
                    value={providerForm.apiKey}
                    onChange={(e) =>
                      setProviderForm((f) => ({ ...f, apiKey: e.target.value }))
                    }
                    placeholder={
                      editingProviderId
                        ? "Leave unchanged or enter new value"
                        : providerForm.providerType === "cloudflare"
                          ? "Cloudflare AI Gateway token"
                          : "sk-..."
                    }
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
                  />
                </div>
                {providerForm.providerType === "cloudflare" && (
                  <div>
                    <label htmlFor="provider-cf-byok" className="block text-sm font-medium mb-1">
                      cf-aig-byok-alias{" "}
                      <span className="text-muted-foreground font-normal">(optional)</span>
                    </label>
                    <input
                      id="provider-cf-byok"
                      type="text"
                      value={providerForm.cfAigByokAlias}
                      onChange={(e) =>
                        setProviderForm((f) => ({ ...f, cfAigByokAlias: e.target.value }))
                      }
                      placeholder="my-stored-key-alias"
                      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
                    />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2 mt-4">
                <button type="button"
                  onClick={handleProviderSubmit}
                  disabled={providerSaving || !providerForm.name.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {providerSaving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  {editingProviderId ? "Update" : "Create"} Provider
                </button>
                <button type="button"
                  onClick={() => {
                    setShowProviderForm(false);
                    setEditingProviderId(null);
                  }}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Provider list */}
        {providers.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <Server className="size-10 mx-auto mb-3 opacity-30" />
              <p className="font-medium">No providers configured</p>
              <p className="text-sm mt-1">
                Add an OpenAI or local provider to get started.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {providers.map((p) => (
              <Card
                key={p.id}
                className={`transition-colors ${
                  !p.isActive
                    ? "opacity-60 border-dashed"
                    : ""
                }`}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={`size-2 rounded-full ${
                          p.isActive ? "bg-green-500" : "bg-gray-400"
                        }`}
                      />
                      <CardTitle className="text-base">{p.name}</CardTitle>
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                          p.providerType === "openai"
                            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                            : p.providerType === "cloudflare"
                              ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400"
                              : "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400"
                        }`}
                      >
                        {p.providerType === "openai" ? (
                          <Globe className="size-3" />
                        ) : p.providerType === "cloudflare" ? (
                          <Cloud className="size-3" />
                        ) : (
                          <Monitor className="size-3" />
                        )}
                        {p.providerType}
                      </span>
                      {p.hasApiKey && (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Key className="size-3" /> {p.maskedApiKey}
                        </span>
                      )}
                      {p.providerType === "cloudflare" && p.cfAigByokAlias && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-orange-50 px-1.5 py-0.5 text-xs text-orange-700 dark:bg-orange-950/40 dark:text-orange-300"
                          title="BYOK alias"
                        >
                          alias: {p.cfAigByokAlias}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button type="button"
                        onClick={() =>
                          setExpandedProvider(
                            expandedProvider === p.id ? null : p.id
                          )
                        }
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                        title="Manage models"
                      >
                        {expandedProvider === p.id ? (
                          <ChevronUp className="size-4" />
                        ) : (
                          <ChevronDown className="size-4" />
                        )}
                      </button>
                      <button type="button"
                        onClick={() => handleToggleActive(p)}
                        className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                          p.isActive
                            ? "text-yellow-700 hover:bg-yellow-50 dark:text-yellow-400 dark:hover:bg-yellow-900/20"
                            : "text-green-700 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-900/20"
                        }`}
                      >
                        {p.isActive ? "Disable" : "Enable"}
                      </button>
                      <button type="button"
                        onClick={() => handleEditProvider(p)}
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                        title="Edit provider"
                      >
                        <Settings2 className="size-4" />
                      </button>
                      <button type="button"
                        onClick={() => handleDeleteProvider(p.id)}
                        className="rounded-md p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                        title="Delete provider"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                  {p.baseUrl && (
                    <p className="text-xs text-muted-foreground mt-1 font-mono truncate">
                      {p.baseUrl}
                    </p>
                  )}
                </CardHeader>

                {/* Models section (expanded) */}
                {expandedProvider === p.id && (
                  <CardContent className="pt-0 border-t mt-2">
                    <div className="flex items-center justify-between mt-3 mb-2">
                      <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                        Models ({p.models.length})
                      </h4>
                      <div className="flex items-center gap-2">
                        {(p.providerType === "local" || p.providerType === "cloudflare") && (
                          <button type="button"
                            onClick={() => handleDiscover(p.id)}
                            disabled={discovering === p.id}
                            className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 transition-colors"
                          >
                            <RefreshCw
                              className={`size-3.5 ${
                                discovering === p.id ? "animate-spin" : ""
                              }`}
                            />
                            Discover Models
                          </button>
                        )}
                        <button type="button"
                          onClick={() => {
                            setModelForm(EMPTY_MODEL_FORM);
                            setShowModelForm(p.id);
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
                        >
                          <Plus className="size-3.5" /> Add Model
                        </button>
                      </div>
                    </div>

                    {/* Model add form */}
                    {showModelForm === p.id && (
                      <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-900 dark:bg-blue-950/20">
                        <div className="grid gap-3 sm:grid-cols-3">
                          <input
                            type="text"
                            placeholder="Model ID (e.g. gpt-5.1)"
                            aria-label="Model ID"
                            value={modelForm.modelId}
                            onChange={(e) =>
                              setModelForm((f) => ({
                                ...f,
                                modelId: e.target.value,
                              }))
                            }
                            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
                          />
                          <input
                            type="text"
                            placeholder="Display name (optional)"
                            aria-label="Display name"
                            value={modelForm.displayName}
                            onChange={(e) =>
                              setModelForm((f) => ({
                                ...f,
                                displayName: e.target.value,
                              }))
                            }
                            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
                          />
                          <Select
                            value={modelForm.serviceTier || "none"}
                            onValueChange={(v) =>
                              setModelForm((f) => ({
                                ...f,
                                serviceTier: v === "none" ? "" : v,
                              }))
                            }
                          >
                            <SelectTrigger className="h-8 text-sm">
                              <SelectValue placeholder="Service Tier" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">No Service Tier</SelectItem>
                              <SelectItem value="flex">Flex</SelectItem>
                              <SelectItem value="auto">Auto</SelectItem>
                              <SelectItem value="default">Default</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center gap-3 mt-3">
                          <label className="flex items-center gap-1.5 text-sm">
                            <input
                              type="checkbox"
                              aria-label="Default model"
                              checked={modelForm.isDefault}
                              onChange={(e) =>
                                setModelForm((f) => ({
                                  ...f,
                                  isDefault: e.target.checked,
                                }))
                              }
                              className="rounded"
                            />
                            Default model
                          </label>
                          <div className="flex-1" />
                          <button type="button"
                            onClick={() => handleModelSubmit(p.id)}
                            disabled={modelSaving || !modelForm.modelId.trim()}
                            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                          >
                            {modelSaving ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Plus className="size-3" />
                            )}
                            Add
                          </button>
                          <button type="button"
                            onClick={() => setShowModelForm(null)}
                            className="rounded-md border border-gray-300 px-3 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Model list */}
                    {p.models.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-2">
                        No models added yet.
                      </p>
                    ) : (
                      <div className="divide-y divide-gray-100 dark:divide-gray-800">
                        {p.models.map((m) => (
                          <div
                            key={m.id}
                            className="flex items-center justify-between py-2"
                          >
                            <div className="flex items-center gap-2">
                              <code className="text-sm font-mono bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded">
                                {m.modelId}
                              </code>
                              {m.displayName && (
                                <span className="text-sm text-muted-foreground">
                                  ({m.displayName})
                                </span>
                              )}
                              {m.serviceTier && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                  <Zap className="size-3" /> {m.serviceTier}
                                </span>
                              )}
                              {m.isDefault && (
                                <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
                                  default
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <button type="button"
                                onClick={() => handleEditModelOpen(p.id, m)}
                                className="rounded p-1 text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                                title="Edit model"
                              >
                                <Pencil className="size-3.5" />
                              </button>
                              <button type="button"
                                onClick={() => handleDeleteModel(p.id, m.id)}
                                className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                                title="Delete model"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ─── Section 2: Use Case Assignments ──────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-semibold flex items-center gap-2">
              <Settings2 className="size-5" /> Use Case Assignments
            </h2>
            <p className="text-sm text-muted-foreground">
              Assign a provider and model to each use case.
            </p>
          </div>
          <button type="button"
            onClick={handleSaveAssignments}
            disabled={
              assignmentSaving || Object.keys(assignmentEdits).length === 0
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {assignmentSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save Assignments
          </button>
        </div>

        <div className="space-y-3">
          {Object.entries(USE_CASE_LABELS).map(([useCase, label]) => {
            const effective = getEffectiveAssignment(useCase);
            const selectedModels = getModelsForProvider(effective.providerId);
            const test = testResults[useCase];

            return (
              <Card key={useCase}>
                <CardContent className="pt-6">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium text-sm">{label}</h3>
                    <div className="flex items-center gap-2">
                      {assignments[useCase] && (
                        <button type="button"
                          onClick={() => handleTestConnection(useCase)}
                          disabled={test?.loading}
                          className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50 transition-colors"
                        >
                          {test?.loading ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Zap className="size-3.5" />
                          )}
                          Test Connection
                        </button>
                      )}
                      {useCase in assignmentEdits && (
                        <span className="text-xs text-amber-600 font-medium">
                          unsaved
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label id={`provider-label-${useCase}`} htmlFor={`provider-select-${useCase}`} className="block text-xs font-medium text-muted-foreground mb-1">
                        Provider
                      </label>
                      <Select
                        aria-labelledby={`provider-label-${useCase}`}
                        value={effective.providerId || "none"}
                        onValueChange={(v) =>
                          handleAssignmentChange(
                            useCase,
                            "providerId",
                            v === "none" ? "" : v
                          )
                        }
                      >
                        <SelectTrigger id={`provider-select-${useCase}`} className="h-9">
                          <SelectValue placeholder="Select a provider" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none"> -  Not assigned - </SelectItem>
                          {providers.flatMap((p) =>
                            p.isActive
                              ? [
                                  <SelectItem key={p.id} value={p.id}>
                                    <span className="flex items-center gap-2">
                                      {p.providerType === "openai" ? (
                                        <Globe className="size-3" />
                                      ) : p.providerType === "cloudflare" ? (
                                        <Cloud className="size-3" />
                                      ) : (
                                        <Monitor className="size-3" />
                                      )}
                                      {p.name}
                                    </span>
                                  </SelectItem>,
                                ]
                              : []
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <label id={`model-label-${useCase}`} htmlFor={`model-select-${useCase}`} className="block text-xs font-medium text-muted-foreground mb-1">
                        Model
                      </label>
                      <Select
                        aria-labelledby={`model-label-${useCase}`}
                        value={effective.modelId || "none"}
                        onValueChange={(v) =>
                          handleAssignmentChange(
                            useCase,
                            "modelId",
                            v === "none" ? "" : v
                          )
                        }
                        disabled={!effective.providerId}
                      >
                        <SelectTrigger className="h-9">
                          <SelectValue
                            placeholder={
                              effective.providerId
                                ? "Select a model"
                                : "Select a provider first"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none"> -  Not assigned - </SelectItem>
                          {selectedModels.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.modelId}
                              {m.displayName
                                ? ` (${m.displayName})`
                                : ""}
                              {m.serviceTier
                                ? ` [${m.serviceTier}]`
                                : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Test result */}
                  {test && !test.loading && (
                    <div
                      className={`mt-3 flex items-center gap-2 rounded-md px-3 py-2 text-xs ${
                        test.success
                          ? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
                          : "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
                      }`}
                    >
                      {test.success ? (
                        <Check className="size-3.5" />
                      ) : (
                        <AlertTriangle className="size-3.5" />
                      )}
                      {test.message}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* ─── Discover Models Modal ────────────────────────────────────────── */}
      <Dialog
        open={!!discoverModal}
        onOpenChange={(next) => {
          if (!next && !discoverAdding) closeDiscoverModal();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discover Models</DialogTitle>
            <DialogDescription>
              {discoverModal
                ? `Select the models you want to add to ${discoverModal.providerName}.`
                : ""}
            </DialogDescription>
          </DialogHeader>

          {discoverModal && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{discoverModal.available.length} model(s) found</span>
                {discoverNewModels.length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedDiscover(
                        allNewSelected ? new Set() : new Set(discoverNewModels)
                      )
                    }
                    className="font-medium text-blue-600 hover:text-blue-800"
                  >
                    {allNewSelected ? "Deselect all" : "Select all"}
                  </button>
                )}
              </div>
              <div className="max-h-72 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100 dark:border-gray-800 dark:divide-gray-800">
                {discoverModal.available.map((modelId) => {
                  const alreadyAdded = discoverModal.existing.has(modelId);
                  return (
                    <label
                      key={modelId}
                      className={`flex items-center gap-2 px-3 py-2 text-sm ${
                        alreadyAdded
                          ? "opacity-60"
                          : "cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        aria-label={`Select model ${modelId}`}
                        className="rounded"
                        disabled={alreadyAdded}
                        checked={alreadyAdded || selectedDiscover.has(modelId)}
                        onChange={() => toggleDiscoverModel(modelId)}
                      />
                      <code className="font-mono">{modelId}</code>
                      {alreadyAdded && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          already added
                        </span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              onClick={closeDiscoverModal}
              disabled={discoverAdding}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAddSelectedModels}
              disabled={discoverAdding || selectedDiscover.size === 0}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {discoverAdding ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Add{selectedDiscover.size > 0 ? ` ${selectedDiscover.size}` : ""} Model
              {selectedDiscover.size === 1 ? "" : "s"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Edit Model Modal ─────────────────────────────────────────────── */}
      <Dialog
        open={!!editingModel}
        onOpenChange={(next) => {
          if (!next && !editModelSaving) setEditingModel(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Model</DialogTitle>
            <DialogDescription>
              Update the model identifier, display name, and service tier.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label htmlFor="edit-model-id" className="block text-sm font-medium mb-1">
                Model ID <span className="text-muted-foreground font-normal">(name)</span>
              </label>
              <input
                id="edit-model-id"
                type="text"
                value={editModelForm.modelId}
                onChange={(e) =>
                  setEditModelForm((f) => ({ ...f, modelId: e.target.value }))
                }
                placeholder="e.g. gpt-5.1"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
              />
            </div>
            <div>
              <label htmlFor="edit-model-name" className="block text-sm font-medium mb-1">
                Display Name{" "}
                <span className="text-muted-foreground font-normal">(alias, optional)</span>
              </label>
              <input
                id="edit-model-name"
                type="text"
                value={editModelForm.displayName}
                onChange={(e) =>
                  setEditModelForm((f) => ({ ...f, displayName: e.target.value }))
                }
                placeholder="Friendly name"
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-hidden focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900"
              />
            </div>
            <div>
              <label id="edit-model-tier-label" className="block text-sm font-medium mb-1">
                Service Tier{" "}
                <span className="text-muted-foreground font-normal">(service level)</span>
              </label>
              <Select
                aria-labelledby="edit-model-tier-label"
                value={editModelForm.serviceTier || "none"}
                onValueChange={(v) =>
                  setEditModelForm((f) => ({
                    ...f,
                    serviceTier: v === "none" ? "" : v,
                  }))
                }
              >
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="Service Tier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Service Tier</SelectItem>
                  <SelectItem value="flex">Flex</SelectItem>
                  <SelectItem value="auto">Auto</SelectItem>
                  <SelectItem value="default">Default</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                aria-label="Default model"
                checked={editModelForm.isDefault}
                onChange={(e) =>
                  setEditModelForm((f) => ({ ...f, isDefault: e.target.checked }))
                }
                className="rounded"
              />
              Default model
            </label>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <button
              type="button"
              onClick={() => setEditingModel(null)}
              disabled={editModelSaving}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleEditModelSubmit}
              disabled={editModelSaving || !editModelForm.modelId.trim()}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {editModelSaving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              Save Changes
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
