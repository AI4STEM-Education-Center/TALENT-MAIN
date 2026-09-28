"use client";
import { useRef, useState } from "react";
import { AlertTriangle, Download, Loader2, Upload } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { errorMessage } from "@/lib/errors";

// Client-side view of the export file. Only what the picker needs — the server
// re-validates the whole bundle on import.
interface BundleProvider {
  name: string;
  providerType: string;
  apiKey?: string | null;
  models?: unknown[];
}
interface BundleAssignment {
  providerName: string;
  providerType: string;
  modelId: string;
}
interface Bundle {
  format?: string;
  exportedAt?: string;
  providers: BundleProvider[];
  assignments: Record<string, BundleAssignment | null>;
  assistants?: unknown[];
  guardrails?: unknown;
}

interface LoadedBundle {
  bundle: Bundle;
  /** Human-readable export time, formatted once when the file is read. */
  exportedLabel: string | null;
  /** Bumped per file so the dialog remounts with fresh selections. */
  version: number;
}

interface ImportReport {
  providers: { name: string; providerType: string; result: string }[];
  useCases: { useCase: string; result: string }[];
  assistants: string | null;
  guardrails: string | null;
  removedProviders: number;
}

// Mirrors providerKey() in src/lib/ai-config-transfer.ts.
const keyOf = (p: { name: string; providerType: string }) =>
  `${p.providerType}:${p.name}`;

const OUTLINE_BUTTON =
  "inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800 transition-colors";

async function readBundle(file: File): Promise<Bundle> {
  let parsed: Bundle;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error("Could not read the file: it is not valid JSON.");
  }
  if (
    parsed?.format !== "talent-ai-config" ||
    !Array.isArray(parsed.providers)
  ) {
    throw new Error("This file is not an AI config export.");
  }
  parsed.assignments ??= {};
  return parsed;
}

/**
 * Export / import of the whole AI configuration, for moving a setup between
 * dev and prod. Export is everything; import lets the admin pick providers and
 * use cases, and optionally wipe the current config first.
 */
export function AiConfigTransfer({
  useCaseLabels,
  onImported,
}: {
  useCaseLabels: Record<string, string>;
  onImported: () => void | Promise<void>;
}) {
  const confirm = useConfirm();
  const fileInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState<LoadedBundle | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);

  const handleExport = async () => {
    const ok = await confirm({
      title: "Export AI configuration?",
      description:
        "The file contains every provider's API key in plain text. Store it like a password and delete it once it has been imported.",
      confirmText: "Download",
    });
    if (!ok) return;
    // A plain navigation: the route answers with Content-Disposition, so the
    // browser saves the file without the JSON passing through React state.
    window.location.href = "/api/admin/ai-config/export";
  };

  const handleFile = async (file: File) => {
    setError("");
    setReport(null);
    try {
      const bundle = await readBundle(file);
      const exportedAt = bundle.exportedAt ? new Date(bundle.exportedAt) : null;
      setLoaded((prev) => ({
        bundle,
        exportedLabel:
          exportedAt && !Number.isNaN(exportedAt.getTime())
            ? exportedAt.toLocaleString()
            : null,
        version: (prev?.version ?? 0) + 1,
      }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={handleExport} className={OUTLINE_BUTTON}>
          <Download className="size-4" /> Export config
        </button>
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className={OUTLINE_BUTTON}
        >
          <Upload className="size-4" /> Import config
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          aria-label="AI config file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Reset so choosing the same file again still fires onChange.
            e.target.value = "";
            if (file) void handleFile(file);
          }}
        />
      </div>

      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {report && (
        <ImportReportPanel
          report={report}
          useCaseLabels={useCaseLabels}
          onDismiss={() => setReport(null)}
        />
      )}

      {loaded && (
        <ImportDialog
          key={loaded.version}
          bundle={loaded.bundle}
          exportedLabel={loaded.exportedLabel}
          useCaseLabels={useCaseLabels}
          onClose={() => setLoaded(null)}
          onDone={async (next) => {
            setLoaded(null);
            setReport(next);
            await onImported();
          }}
        />
      )}
    </>
  );
}

function ImportReportPanel({
  report,
  useCaseLabels,
  onDismiss,
}: {
  report: ImportReport;
  useCaseLabels: Record<string, string>;
  onDismiss: () => void;
}) {
  return (
    <div className="mt-3 rounded-lg border border-green-200 bg-green-50 p-3 text-sm dark:border-green-900 dark:bg-green-950/30">
      <div className="mb-1 flex items-center justify-between font-medium">
        Import finished
        <button
          type="button"
          aria-label="Dismiss import report"
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      </div>
      <ul className="space-y-0.5 text-muted-foreground">
        {report.removedProviders > 0 && (
          <li>Removed {report.removedProviders} existing provider(s)</li>
        )}
        {report.providers.map((p) => (
          <li key={keyOf(p)}>
            <span className="text-foreground">{p.name}</span>: {p.result}
          </li>
        ))}
        {report.useCases.map((u) => (
          <li key={u.useCase}>
            <span className="text-foreground">
              {useCaseLabels[u.useCase] ?? u.useCase}
            </span>
            : {u.result}
          </li>
        ))}
        {report.assistants && <li>Chat assistants: {report.assistants}</li>}
        {report.guardrails && <li>Guardrails: {report.guardrails}</li>}
      </ul>
    </div>
  );
}

interface SelectableItem {
  key: string;
  label: string;
  detail: string;
}

/** A titled checkbox list with a select-all / select-none toggle. */
function SelectableList({
  title,
  items,
  selected,
  onChange,
}: {
  title: string;
  items: SelectableItem[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const allSelected = items.length > 0 && selected.size === items.length;
  return (
    <fieldset>
      <legend className="mb-2 flex w-full items-center justify-between font-medium">
        {title}
        {items.length > 0 && (
          <button
            type="button"
            className="text-xs font-normal text-blue-600 hover:underline"
            onClick={() =>
              onChange(
                allSelected ? new Set() : new Set(items.map((i) => i.key)),
              )
            }
          >
            {allSelected ? "Select none" : "Select all"}
          </button>
        )}
      </legend>
      {items.length === 0 && (
        <p className="text-muted-foreground">None in file.</p>
      )}
      <div className="space-y-1.5">
        {items.map((item) => (
          <label key={item.key} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 rounded"
              checked={selected.has(item.key)}
              onChange={(e) => {
                const next = new Set(selected);
                if (e.target.checked) next.add(item.key);
                else next.delete(item.key);
                onChange(next);
              }}
            />
            <span>
              {item.label}
              <span className="block text-xs text-muted-foreground">
                {item.detail}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ImportDialog({
  bundle,
  exportedLabel,
  useCaseLabels,
  onClose,
  onDone,
}: {
  bundle: Bundle;
  exportedLabel: string | null;
  useCaseLabels: Record<string, string>;
  onClose: () => void;
  onDone: (report: ImportReport) => Promise<void>;
}) {
  const confirm = useConfirm();
  const providerItems = bundle.providers.map((p) => ({
    key: keyOf(p),
    label: p.name,
    detail: `${p.providerType} · ${p.models?.length ?? 0} model(s) · ${p.apiKey ? "API key included" : "no API key"}`,
  }));
  const useCaseItems = Object.entries(bundle.assignments).map(([uc, a]) => ({
    key: uc,
    label: useCaseLabels[uc] ?? uc,
    detail: a
      ? `${a.providerName} — ${a.modelId}`
      : "Unassigned (importing clears it here)",
  }));

  const [selectedProviders, setSelectedProviders] = useState(
    () => new Set(providerItems.map((i) => i.key)),
  );
  const [selectedUseCases, setSelectedUseCases] = useState(
    () => new Set(useCaseItems.map((i) => i.key)),
  );
  const [includeAssistants, setIncludeAssistants] = useState(
    !!bundle.assistants?.length,
  );
  const [includeGuardrails, setIncludeGuardrails] = useState(
    !!bundle.guardrails,
  );
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  // Synchronous re-entry guard: `importing` only lands after a re-render.
  const inFlight = useRef(false);

  const nothingSelected =
    selectedProviders.size === 0 &&
    selectedUseCases.size === 0 &&
    !includeAssistants &&
    !includeGuardrails;

  const handleImport = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      if (replaceExisting) {
        const ok = await confirm({
          title: "Overwrite all existing AI config?",
          description:
            "Every provider, model and use-case assignment on this site is deleted before the selected ones are imported. Providers you leave unticked will be gone.",
          confirmText: "Overwrite",
          variant: "destructive",
        });
        if (!ok) return;
      }

      setImporting(true);
      setError("");
      const res = await fetch("/api/admin/ai-config/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundle,
          options: {
            providers: [...selectedProviders],
            useCases: [...selectedUseCases],
            assistants: includeAssistants,
            guardrails: includeGuardrails,
            replaceExisting,
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Import failed (${res.status})`);
      }
      const data = (await res.json()) as { report: ImportReport };
      await onDone(data.report);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setImporting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !importing) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Import AI configuration</DialogTitle>
          <DialogDescription>
            {exportedLabel ? `Exported ${exportedLabel}. ` : ""}
            Choose what to bring in. Providers are matched by name and type; a
            matched provider is updated rather than duplicated.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 text-sm">
          <SelectableList
            title="Providers"
            items={providerItems}
            selected={selectedProviders}
            onChange={setSelectedProviders}
          />

          <div>
            <SelectableList
              title="Use-case assignments"
              items={useCaseItems}
              selected={selectedUseCases}
              onChange={setSelectedUseCases}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              An assignment whose provider is not ticked still imports if this
              site already has that provider and model.
            </p>
          </div>

          <fieldset className="space-y-1.5">
            <legend className="mb-2 font-medium">Other settings</legend>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="rounded"
                disabled={!bundle.assistants?.length}
                checked={includeAssistants}
                onChange={(e) => setIncludeAssistants(e.target.checked)}
              />
              Chat assistant settings
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="rounded"
                disabled={!bundle.guardrails}
                checked={includeGuardrails}
                onChange={(e) => setIncludeGuardrails(e.target.checked)}
              />
              Guardrail settings
            </label>
          </fieldset>

          <label className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/30">
            <input
              type="checkbox"
              className="mt-0.5 rounded"
              checked={replaceExisting}
              onChange={(e) => setReplaceExisting(e.target.checked)}
            />
            <span>
              <span className="font-medium text-red-700 dark:text-red-400">
                Overwrite all existing
              </span>
              <span className="block text-xs text-muted-foreground">
                Delete every provider, model and assignment on this site first,
                so it ends up with exactly what is selected above. Otherwise the
                import merges into the current config.
              </span>
            </span>
          </label>

          {error && (
            <p
              role="alert"
              className="flex items-center gap-1.5 text-red-600 dark:text-red-400"
            >
              <AlertTriangle className="size-4 shrink-0" />
              {error}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <button
            type="button"
            onClick={onClose}
            disabled={importing}
            className={OUTLINE_BUTTON}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleImport}
            disabled={importing || nothingSelected}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${
              replaceExisting
                ? "bg-red-600 hover:bg-red-700"
                : "bg-blue-600 hover:bg-blue-700"
            }`}
          >
            {importing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {replaceExisting ? "Overwrite and import" : "Import selected"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
