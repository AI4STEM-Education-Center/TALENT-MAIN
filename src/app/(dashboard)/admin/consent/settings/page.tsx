"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAlert } from "@/components/ui/confirm-dialog";
import { Loader2 } from "lucide-react";

interface Settings {
  maxEmailAttachmentBytes: number;
  bulkExportBatchSize: number;
  bulkExportInlineThreshold: number;
  bulkExportMaxRecords: number;
  bulkExportRetentionHours: number;
}

const FIELDS: { key: keyof Settings; label: string; hint: string }[] = [
  {
    key: "maxEmailAttachmentBytes",
    label: "Max email attachment size (bytes)",
    hint: "PDFs/CSVs larger than this are omitted from the email; the recipient signs in to view them instead.",
  },
  {
    key: "bulkExportBatchSize",
    label: "Bulk export batch size (records)",
    hint: "How many records the background worker renders at a time — bounds peak memory during a large export.",
  },
  {
    key: "bulkExportInlineThreshold",
    label: "Inline preview threshold (records)",
    hint: "Selections at or below this count generate instantly; larger ones always run as a background job.",
  },
  {
    key: "bulkExportMaxRecords",
    label: "Max records per export job",
    hint: "Requests above this are rejected outright, asking the admin to narrow the filter.",
  },
  {
    key: "bulkExportRetentionHours",
    label: "Export file retention (hours)",
    hint: "How long a finished export .zip stays downloadable in storage before it's cleaned up.",
  },
];

export default function AdminConsentSettingsPage() {
  const alert = useAlert();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  // react-doctor-disable-next-line react-doctor/no-set-state-after-await-in-effect -- the fetch is aborted by the effect's AbortController cleanup, so no stale write can land
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch("/api/admin/consent/settings", {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error("Could not load consent export settings.");
        setSettings(await res.json());
      } catch (cause) {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          await alert({
            title: "Couldn't load settings",
            description:
              cause instanceof Error ? cause.message : "Unknown error.",
          });
        }
      }
    }
    void load();
    return () => controller.abort();
  }, [alert]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/consent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        await alert({
          title: "Couldn't save",
          description: data?.error || "Unknown error.",
        });
        return;
      }
      const data = await res.json();
      setSettings(data);
      await alert("Settings saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div>
        <h1 className="text-3xl font-bold">Consent Export Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          These knobs bound how much RAM, CPU time, and storage a consent
          PDF/zip export can consume — sized for a resource-constrained
          deployment. Bulk generation always runs in the background worker,
          never inline in a web request.
        </p>
      </div>

      {!settings ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="mr-2 size-5 animate-spin" /> Loading…
        </div>
      ) : (
        <Card>
          <CardContent className="space-y-5 pt-6">
            {FIELDS.map((field) => (
              <div key={field.key} className="space-y-1">
                <Label htmlFor={field.key}>{field.label}</Label>
                <Input
                  id={field.key}
                  type="number"
                  value={settings[field.key]}
                  onChange={(e) =>
                    setSettings((prev) =>
                      prev
                        ? { ...prev, [field.key]: Number(e.target.value) }
                        : prev,
                    )
                  }
                />
                <p className="text-xs text-muted-foreground">{field.hint}</p>
              </div>
            ))}
            <Button onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
