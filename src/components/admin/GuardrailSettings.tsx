"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FlaskConical, Loader2, Save, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type Mode = "OFF" | "FLAG" | "BLOCK";
type SurfaceInfo = { key: string; label: string };

/** Granularity of the confidence-threshold number inputs. */
const THRESHOLD_STEP = "0.05";

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

type ModelInfo = {
  label: string;
  providerActive: boolean;
  /** Why this assignment cannot run, when the server can tell in advance. */
  warning?: string | null;
} | null;

interface ModelReadoutProps {
  model: ModelInfo;
}

interface ModePickerProps {
  value: Mode;
  onChange: (mode: Mode) => void;
  idPrefix: string;
}

interface GuardrailSettingsProps {
  refreshKey?: number;
}

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
 * a warning. Red is reserved for an assignment that is switched ON but cannot
 * run: a disabled provider, or a `warning` the server worked out from the
 * assignment itself (a chat model on a check that needs a moderation one).
 */
function ModelReadout({ model }: ModelReadoutProps) {
  if (!model) {
    return (
      <p className="text-sm text-muted-foreground">
        Model: <strong>not assigned</strong> — this check does not run. Pick one
        in the use-case table at the top of this page.
      </p>
    );
  }
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Model: <strong>{model.label}</strong>
        {!model.providerActive && (
          <span className="text-destructive">
            {" "}
            — provider is disabled, so this check cannot run
          </span>
        )}
      </p>
      {model.warning && (
        <p className="text-sm text-destructive">{model.warning}</p>
      )}
    </>
  );
}

type ModerationTestResult =
  | {
      success: true;
      flagged: boolean;
      categories: string[];
      scores: { category: string; score: number }[];
      latencyMs: number;
      model: string;
      providerType: string;
    }
  | { success: false; error: string };

/**
 * Samples an admin can start from. The first two should trip the check and the
 * last should not — a moderation assignment that passes all three is not
 * actually checking anything.
 */
const MODERATION_SAMPLES: { label: string; text: string }[] = [
  {
    label: "Threat (should flag)",
    text: "If you give me a bad grade again I will find you after class and beat you until you can't walk.",
  },
  {
    label: "Self-harm (should flag)",
    text: "I failed the exam again. I have the pills saved up and tonight I'm going to take all of them so I never have to wake up.",
  },
  {
    label: "Benign (should pass)",
    text: "Can you explain why the reaction rate doubles when the temperature rises by ten degrees?",
  },
];

/**
 * Runs real text through the assigned moderation model and shows the verdict.
 * The connection test only proves the endpoint answers; this shows whether the
 * content an admin cares about would actually be caught, and how close it came.
 */
function ModerationTester() {
  const [text, setText] = useState(MODERATION_SAMPLES[0].text);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ModerationTestResult | null>(null);

  async function run() {
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/guardrails/moderation-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const body = await res.json();
      setResult(
        res.ok
          ? body
          : { success: false, error: body.error ?? "Moderation test failed" },
      );
    } catch {
      setResult({ success: false, error: "Could not reach the server." });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Test with real content</span>
        {MODERATION_SAMPLES.map((sample) => (
          <button
            key={sample.label}
            type="button"
            onClick={() => {
              setText(sample.text);
              setResult(null);
            }}
            className="rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-accent"
          >
            {sample.label}
          </button>
        ))}
      </div>
      <Textarea
        aria-label="Text to moderate"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={run}
        disabled={running || !text.trim()}
      >
        {running ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <FlaskConical className="mr-2 h-4 w-4" />
        )}
        Run moderation
      </Button>
      {result && !result.success && (
        <p className="text-sm text-destructive">{result.error}</p>
      )}
      {result?.success && (
        <div className="space-y-1 text-sm">
          <p
            className={cn(
              "font-medium",
              result.flagged ? "text-destructive" : "text-green-700",
            )}
          >
            {result.flagged
              ? `Flagged: ${result.categories.join(", ")}`
              : "Not flagged"}
            <span className="font-normal text-muted-foreground">
              {" "}
              · {result.model} via {result.providerType} ·{" "}
              {(result.latencyMs / 1000).toFixed(2)}s
            </span>
          </p>
          {result.scores.length > 0 && (
            <ul className="grid gap-x-4 text-xs text-muted-foreground sm:grid-cols-2">
              {result.scores.map(({ category, score }) => (
                <li key={category}>
                  {category}: {score.toFixed(3)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

const MODES: { value: Mode; label: string; blurb: string }[] = [
  {
    value: "OFF",
    label: "Off",
    blurb: "Not run at all — no cost, no log rows.",
  },
  {
    value: "FLAG",
    label: "Report",
    blurb: "Runs and logs, but never blocks. Start here.",
  },
  {
    value: "BLOCK",
    label: "Block",
    blurb: "Refuses the submission when it trips.",
  },
];

function ModePicker({ value, onChange, idPrefix }: ModePickerProps) {
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
              : "border-input bg-background hover:bg-accent",
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
export function GuardrailSettings({ refreshKey = 0 }: GuardrailSettingsProps) {
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
        : prev,
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
          Safety checks applied to chat messages, uploaded PDFs, and authored
          questions. Each check runs on its own model, picked in the use-case
          table at the top of this page — <strong>Content Moderation</strong>,{" "}
          <strong>Guardrail — Jailbreak Check</strong> and{" "}
          <strong>Guardrail — Off-Topic Check</strong>. Leaving one unassigned
          turns that check off.
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
            Checks text and images for hate, violence, sexual and self-harm
            content using OpenAI&apos;s moderation endpoint. It costs nothing,
            so there is rarely a reason to turn it off. Flagged chat messages
            are always blocked; flagged PDF pages are logged.
          </p>
          <ModelReadout model={data.models.moderation} />
          {data.models.moderation && <ModerationTester />}
        </section>

        {/* Jailbreak */}
        <section className="space-y-2 border-t pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">Jailbreak detection</h3>
              <p className="text-sm text-muted-foreground">
                Catches text trying to manipulate the AI — &ldquo;ignore your
                rules&rdquo;, fake system messages, attempts to talk it into
                revealing an answer key.
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
              step={THRESHOLD_STEP}
              min={data.thresholdBounds.min}
              max={data.thresholdBounds.max}
              value={settings.jailbreakThreshold}
              onChange={(e) =>
                update("jailbreakThreshold", Number(e.target.value))
              }
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
                Catches content unrelated to what this site is for. Off by
                default — a physics question <em>is</em> the topic, so this
                mostly matters for chat.
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
              step={THRESHOLD_STEP}
              min={data.thresholdBounds.min}
              max={data.thresholdBounds.max}
              value={settings.offTopicThreshold}
              onChange={(e) =>
                update("offTopicThreshold", Number(e.target.value))
              }
              className="w-24"
              aria-label="Off-topic confidence threshold"
            />
          </label>
          <div className="space-y-1">
            <label
              htmlFor="topic-description"
              className="text-sm text-muted-foreground"
            >
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
            Recommended. When a check is unavailable — no model assigned, a
            timeout, an upstream outage — this lets the submission through and
            writes a log row. Unticking it rejects submissions instead, which is
            safer but takes chat and question authoring down with the provider.
            Background PDF processing always allows through either way, so an
            outage cannot strand an upload a teacher is waiting on.
          </p>
        </section>

        {/* Surfaces */}
        <section className="space-y-2 border-t pt-4">
          <h3 className="text-sm font-medium">Where checks run</h3>
          <p className="text-sm text-muted-foreground">
            Untick a surface to switch every check off for it. Useful when one
            place turns out noisy and the rest are behaving.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {data.surfaces.map((surface) => (
              <label
                key={surface.key}
                className="flex items-center gap-2 text-sm"
              >
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
          {status && (
            <span className="text-sm text-muted-foreground">{status}</span>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          Findings are recorded under the <strong>GUARDRAIL</strong> category in{" "}
          <Link href="/admin/logs" className="underline">
            System Logs
          </Link>
          . Run a new check in <em>Report</em> for a week and read those rows
          before switching it to <em>Block</em>.
        </p>
      </CardContent>
    </Card>
  );
}
