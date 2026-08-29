"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Mode = "OFF" | "FLAG" | "BLOCK";
type SurfaceInfo = { key: string; label: string };

type Settings = {
  moderationEnabled: boolean;
  jailbreakMode: Mode;
  offTopicMode: Mode;
  jailbreakThreshold: number;
  offTopicThreshold: number;
  topicDescription: string;
  failOpen: boolean;
  disabledSurfaces: string[];
};

type ModelInfo = { label: string; providerActive: boolean } | null;

type Payload = {
  settings: Settings;
  surfaces: SurfaceInfo[];
  defaultTopicDescription: string;
  maxTopicDescriptionChars: number;
  thresholdBounds: { min: number; max: number };
  /** Keyed by use case: moderation, guardrail_jailbreak, guardrail_offtopic. */
  models: Record<string, ModelInfo>;
  /** True when both LLM checks resolve to the same model, i.e. one call. */
  sharesOneCall: boolean;
};

/**
 * What a check is currently running on. Unassigned is not an error state — it
 * is how a check is switched off — so it reads as a plain statement rather than
 * a warning, and only an INACTIVE provider is called out in red.
 */
function ModelReadout({ model }: { model: ModelInfo }) {
  if (!model) {
    return (
      <p className="text-sm text-muted-foreground">
        Model: <strong>not assigned</strong> — this check does not run. Pick one in the use-case
        table at the top of this page.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      Model: <strong>{model.label}</strong>
      {!model.providerActive && (
        <span className="text-destructive"> — provider is disabled, so this check cannot run</span>
      )}
    </p>
  );
}

const MODES: { value: Mode; label: string; blurb: string }[] = [
  { value: "OFF", label: "Off", blurb: "Not run at all — no cost, no log rows." },
  { value: "FLAG", label: "Report", blurb: "Runs and logs, but never blocks. Start here." },
  { value: "BLOCK", label: "Block", blurb: "Refuses the submission when it trips." },
];

function ModePicker({
  value,
  onChange,
  idPrefix,
}: {
  value: Mode;
  onChange: (mode: Mode) => void;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Mode">
      {MODES.map((mode) => (
        <button
          key={mode.value}
          type="button"
          id={`${idPrefix}-${mode.value}`}
          onClick={() => onChange(mode.value)}
          aria-pressed={value === mode.value}
          title={mode.blurb}
          className={cn(
            "rounded-md border px-3 py-1.5 text-sm transition-colors",
            value === mode.value
              ? "border-primary bg-primary text-primary-foreground"
              : "border-input bg-background hover:bg-accent"
          )}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Guardrail policy panel. The MODEL each check runs on is picked in the use-case
 * table above (Content Moderation / Guardrail Checks); this card is the
 * behaviour around them.
 */
export function GuardrailSettings({ refreshKey = 0 }: { refreshKey?: number }) {
  const [data, setData] = useState<Payload | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/admin/guardrails");
        if (!res.ok) throw new Error("Failed to load guardrail settings");
        const payload: Payload = await res.json();
        if (cancelled) return;
        setData(payload);
        setSettings(payload.settings);
      } catch {
        if (!cancelled) setStatus("Could not load guardrail settings.");
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-read after the use-case table saves, so the model read-outs below
    // cannot disagree with the assignments the admin just changed.
  }, [refreshKey]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));

  const toggleSurface = (key: string) =>
    setSettings((prev) =>
      prev
        ? {
            ...prev,
            disabledSurfaces: prev.disabledSurfaces.includes(key)
              ? prev.disabledSurfaces.filter((s) => s !== key)
              : [...prev.disabledSurfaces, key],
          }
        : prev
    );

  async function save() {
    if (!settings) return;
    setSaving(true);
    setStatus(null);
    try {
      const res = await fetch("/api/admin/guardrails", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (!res.ok) throw new Error("Save failed");
      // The server normalizes and bounds every field, so the response — not the
      // form state — is the truth about what was stored.
      const saved: { settings: Settings } = await res.json();
      setSettings(saved.settings);
      setStatus("Saved.");
    } catch {
      setStatus("Could not save guardrail settings.");
    } finally {
      setSaving(false);
    }
  }

  if (!data || !settings) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" /> Guardrails
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          {status ?? "Loading…"}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5" /> Guardrails
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Safety checks applied to chat messages, uploaded PDFs, and authored questions. Each
          check runs on its own model, picked in the use-case table at the top of this page —{" "}
          <strong>Content Moderation</strong>, <strong>Guardrail — Jailbreak Check</strong> and{" "}
          <strong>Guardrail — Off-Topic Check</strong>. Leaving one unassigned turns that check
          off.
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Moderation */}
        <section className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={settings.moderationEnabled}
              onChange={(e) => update("moderationEnabled", e.target.checked)}
            />
            Content moderation (free)
          </label>
          <p className="text-sm text-muted-foreground">
            Checks text and images for hate, violence, sexual and self-harm content using
            OpenAI&apos;s moderation endpoint. It costs nothing, so there is rarely a reason to
            turn it off. Flagged chat messages are always blocked; flagged PDF pages are logged.
          </p>
          <ModelReadout model={data.models.moderation} />
        </section>

        {/* Jailbreak */}
        <section className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Jailbreak detection</h3>
              <p className="text-sm text-muted-foreground">
                Catches text trying to manipulate the AI — &ldquo;ignore your rules&rdquo;, fake
                system messages, attempts to talk it into revealing an answer key.
              </p>
            </div>
            <ModePicker
              value={settings.jailbreakMode}
              onChange={(mode) => update("jailbreakMode", mode)}
              idPrefix="jailbreak-mode"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Confidence threshold</span>
            <Input
              type="number"
              step="0.05"
              min={data.thresholdBounds.min}
              max={data.thresholdBounds.max}
              value={settings.jailbreakThreshold}
              onChange={(e) => update("jailbreakThreshold", Number(e.target.value))}
              className="w-24"
              aria-label="Jailbreak confidence threshold"
            />
          </label>
          <ModelReadout model={data.models.guardrail_jailbreak} />
        </section>

        {/* Off-topic */}
        <section className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Off-topic detection</h3>
              <p className="text-sm text-muted-foreground">
                Catches content unrelated to what this site is for. Off by default — a physics
                question <em>is</em> the topic, so this mostly matters for chat.
              </p>
            </div>
            <ModePicker
              value={settings.offTopicMode}
              onChange={(mode) => update("offTopicMode", mode)}
              idPrefix="offtopic-mode"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Confidence threshold</span>
            <Input
              type="number"
              step="0.05"
              min={data.thresholdBounds.min}
              max={data.thresholdBounds.max}
              value={settings.offTopicThreshold}
              onChange={(e) => update("offTopicThreshold", Number(e.target.value))}
              className="w-24"
              aria-label="Off-topic confidence threshold"
            />
          </label>
          <div className="space-y-1">
            <label htmlFor="topic-description" className="text-sm text-muted-foreground">
              What counts as on-topic (leave blank for the built-in description)
            </label>
            <Textarea
              id="topic-description"
              rows={3}
              maxLength={data.maxTopicDescriptionChars}
              placeholder={data.defaultTopicDescription}
              value={settings.topicDescription}
              onChange={(e) => update("topicDescription", e.target.value)}
            />
          </div>
          <ModelReadout model={data.models.guardrail_offtopic} />
          <p className="text-sm text-muted-foreground">
            {data.sharesOneCall
              ? "Both checks run on the same model, so one request answers both questions — the second check costs nothing extra."
              : "The two checks are on different models, so each submission makes two requests. Point them at the same model to halve that."}
          </p>
        </section>

        {/* Failure posture */}
        <section className="space-y-2 border-t pt-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={settings.failOpen}
              onChange={(e) => update("failOpen", e.target.checked)}
            />
            Allow content through when a check cannot run
          </label>
          <p className="text-sm text-muted-foreground">
            Recommended. When a check is unavailable — no model assigned, a timeout, an upstream
            outage — this lets the submission through and writes a log row. Unticking it rejects
            submissions instead, which is safer but takes chat and question authoring down with
            the provider. Background PDF processing always allows through either way, so an
            outage cannot strand an upload a teacher is waiting on.
          </p>
        </section>

        {/* Surfaces */}
        <section className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">Where checks run</h3>
          <p className="text-sm text-muted-foreground">
            Untick a surface to switch every check off for it. Useful when one place turns out
            noisy and the rest are behaving.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.surfaces.map((surface) => (
              <label key={surface.key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4"
                  checked={!settings.disabledSurfaces.includes(surface.key)}
                  onChange={() => toggleSurface(surface.key)}
                />
                {surface.label}
              </label>
            ))}
          </div>
        </section>

        <div className="flex items-center gap-3 border-t pt-4">
          <Button onClick={save} disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-2 h-4 w-4" />
            )}
            Save guardrail settings
          </Button>
          {status && <span className="text-sm text-muted-foreground">{status}</span>}
        </div>

        <p className="text-sm text-muted-foreground">
          Findings are recorded under the <strong>GUARDRAIL</strong> category in{" "}
          <a href="/admin/logs" className="underline">
            System Logs
          </a>
          . Run a new check in <em>Report</em> for a week and read those rows before switching it
          to <em>Block</em>.
        </p>
      </CardContent>
    </Card>
  );
}
