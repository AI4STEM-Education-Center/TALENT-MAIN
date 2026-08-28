"use client";

import { useEffect, useState } from "react";
import { Bot, GraduationCap, Loader2, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type ToolInfo = { name: string; label: string };
type SkillInfo = {
  id: string;
  name: string;
  description: string;
  toolNames: string[];
  tools: ToolInfo[];
};
type KindInfo = { kind: string; label: string; accept: string; maxBytes: number };
type Bound = { min: number; max: number };

type Assistant = {
  audience: "student" | "teacher";
  useCase: string;
  enabled: boolean;
  extraInstructions: string;
  enabledSkills: string[];
  disabledTools: string[];
  attachmentKinds: string[];
  maxAttachments: number;
  maxAttachmentBytes: number;
  attachmentRetentionDays: number;
  historyRetentionDays: number;
  maxToolCalls: number;
  maxHistoryMessages: number;
  turnsPerHour: number;
  availableSkills: SkillInfo[];
};

type Payload = {
  assistants: Assistant[];
  attachmentKinds: KindInfo[];
  bounds: Record<string, Bound>;
  maxExtraInstructionsChars: number;
};

const AUDIENCE_LABEL = {
  student: "Student assistant",
  teacher: "Teacher assistant",
} as const;

const AUDIENCE_BLURB = {
  student:
    "Shown to students in the bottom-right of every dashboard page. It can only read that student's own records.",
  teacher:
    "Shown to teachers. It can only read statistics for the classes that teacher owns.",
} as const;

const MIB = 1024 * 1024;

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/**
 * Admin editor for the two chat assistants' behaviour. The provider and model
 * each one uses live in the use-case assignment table above this section — this
 * card is only about what the assistant is allowed to do.
 *
 * Every catalog (skills, attachment kinds, numeric bounds) is served by
 * /api/admin/assistants from the code registries, so a newly written skill
 * appears here with no change to this component.
 */
export function AssistantSettings() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Assistant>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/admin/assistants");
        if (!res.ok) throw new Error("Failed to load assistant settings");
        const data = (await res.json()) as Payload;
        setPayload(data);
        setDrafts(Object.fromEntries(data.assistants.map((a) => [a.audience, a])));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load assistant settings");
      }
    })();
  }, []);

  const update = (audience: string, patch: Partial<Assistant>) => {
    setDrafts((prev) => ({ ...prev, [audience]: { ...prev[audience], ...patch } }));
    setStatus((prev) => ({ ...prev, [audience]: "" }));
  };

  const save = async (audience: string) => {
    const draft = drafts[audience];
    if (!draft) return;
    setSaving(audience);
    setError(null);
    try {
      const res = await fetch("/api/admin/assistants", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audience,
          settings: {
            enabled: draft.enabled,
            extraInstructions: draft.extraInstructions,
            enabledSkills: draft.enabledSkills,
            disabledTools: draft.disabledTools,
            attachmentKinds: draft.attachmentKinds,
            maxAttachments: draft.maxAttachments,
            maxAttachmentBytes: draft.maxAttachmentBytes,
            attachmentRetentionDays: draft.attachmentRetentionDays,
            historyRetentionDays: draft.historyRetentionDays,
            maxToolCalls: draft.maxToolCalls,
            maxHistoryMessages: draft.maxHistoryMessages,
            turnsPerHour: draft.turnsPerHour,
          },
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      const { settings } = (await res.json()) as { settings: Omit<Assistant, "availableSkills" | "useCase"> };
      // Echo back the server's clamped values so the form shows what was stored.
      setDrafts((prev) => ({ ...prev, [audience]: { ...prev[audience], ...settings } }));
      setStatus((prev) => ({ ...prev, [audience]: "Saved" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(null);
    }
  };

  if (error && !payload) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (!payload) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin text-primary" /> Loading assistant settings…
      </div>
    );
  }

  const bounds = payload.bounds;

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {payload.assistants.map((assistant) => {
        const draft = drafts[assistant.audience] ?? assistant;
        const Icon = assistant.audience === "teacher" ? GraduationCap : Bot;
        // Membership sets rather than repeated `includes` — the skill list, the
        // tool list, and the kind chips each test against these on every render.
        const enabledSkills = new Set(draft.enabledSkills);
        const disabledTools = new Set(draft.disabledTools);
        const attachmentKinds = new Set(draft.attachmentKinds);

        return (
          <Card key={assistant.audience}>
            <CardHeader className="pb-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Icon className="size-4 text-primary" />
                  {AUDIENCE_LABEL[assistant.audience]}
                </CardTitle>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-primary"
                    checked={draft.enabled}
                    onChange={(event) =>
                      update(assistant.audience, { enabled: event.target.checked })
                    }
                  />
                  {draft.enabled ? "Enabled" : "Disabled"}
                </label>
              </div>
              <p className="text-xs text-muted-foreground">{AUDIENCE_BLURB[assistant.audience]}</p>
              <p className="text-xs text-muted-foreground">
                Model: set by the{" "}
                <span className="font-medium text-foreground">{assistant.useCase}</span> use-case
                assignment above. A vision-capable model is required for image input.
              </p>
              <p className="text-xs text-muted-foreground">
                Uploaded files are stored for the retention window below, so a later message in the
                same conversation can refer back to them, then deleted automatically.
              </p>
            </CardHeader>

            <CardContent className="space-y-4">
              <fieldset>
                <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
                  Loadable skills
                </legend>
                <div className="space-y-2">
                  {assistant.availableSkills.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No skills are registered for this audience.
                    </p>
                  )}
                  {assistant.availableSkills.map((skill) => (
                    <SkillRow
                      key={skill.id}
                      skill={skill}
                      enabled={enabledSkills.has(skill.id)}
                      disabledTools={disabledTools}
                      onToggleSkill={() =>
                        update(assistant.audience, {
                          enabledSkills: toggle(draft.enabledSkills, skill.id),
                        })
                      }
                      onToggleTool={(name) =>
                        update(assistant.audience, {
                          disabledTools: toggle(draft.disabledTools, name),
                        })
                      }
                    />
                  ))}
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
                  Accepted attachment types
                </legend>
                <div className="flex flex-wrap gap-2">
                  {payload.attachmentKinds.map((kind) => (
                    <label
                      key={kind.kind}
                      className={cn(
                        "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-sm",
                        attachmentKinds.has(kind.kind)
                          ? "border-primary bg-primary/5"
                          : "border-border"
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-primary"
                        checked={attachmentKinds.has(kind.kind)}
                        onChange={() =>
                          update(assistant.audience, {
                            attachmentKinds: toggle(draft.attachmentKinds, kind.kind),
                          })
                        }
                      />
                      {kind.label}
                      <span className="text-xs text-muted-foreground">
                        ≤{Math.round(kind.maxBytes / MIB)} MB
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="grid gap-3 sm:grid-cols-2">
                <NumberField
                  label="Max attachments per message"
                  value={draft.maxAttachments}
                  bound={bounds.maxAttachments}
                  onChange={(value) => update(assistant.audience, { maxAttachments: value })}
                />
                <NumberField
                  label="Max size per attachment (MB)"
                  value={Math.round((draft.maxAttachmentBytes / MIB) * 10) / 10}
                  bound={{
                    min: Math.max(1, Math.round(bounds.maxAttachmentBytes.min / MIB)),
                    max: Math.round(bounds.maxAttachmentBytes.max / MIB),
                  }}
                  step={0.5}
                  onChange={(value) =>
                    update(assistant.audience, {
                      maxAttachmentBytes: Math.round(value * MIB),
                    })
                  }
                />
                <NumberField
                  label="Keep attachments for (days)"
                  value={draft.attachmentRetentionDays}
                  bound={bounds.attachmentRetentionDays}
                  onChange={(value) =>
                    update(assistant.audience, { attachmentRetentionDays: value })
                  }
                />
                <NumberField
                  label="Users can browse history for (days)"
                  value={draft.historyRetentionDays}
                  bound={bounds.historyRetentionDays}
                  onChange={(value) =>
                    update(assistant.audience, { historyRetentionDays: value })
                  }
                  hint="How far back this audience can reopen its own conversations. Older transcripts are archived, not deleted — admins keep reading them under Chat Transcripts."
                />
                <NumberField
                  label="Max tool calls per message"
                  value={draft.maxToolCalls}
                  bound={bounds.maxToolCalls}
                  onChange={(value) => update(assistant.audience, { maxToolCalls: value })}
                />
                <NumberField
                  label="Conversation turns kept as context"
                  value={draft.maxHistoryMessages}
                  bound={bounds.maxHistoryMessages}
                  onChange={(value) => update(assistant.audience, { maxHistoryMessages: value })}
                />
                <NumberField
                  label="Messages per user per hour"
                  value={draft.turnsPerHour}
                  bound={bounds.turnsPerHour}
                  onChange={(value) => update(assistant.audience, { turnsPerHour: value })}
                />
              </div>

              <div>
                <label
                  htmlFor={`extra-${assistant.audience}`}
                  className="mb-1 block text-xs font-medium text-muted-foreground"
                >
                  Extra instructions (appended to the built-in prompt; cannot override its rules)
                </label>
                <Textarea
                  id={`extra-${assistant.audience}`}
                  value={draft.extraInstructions}
                  maxLength={payload.maxExtraInstructionsChars}
                  onChange={(event) =>
                    update(assistant.audience, { extraInstructions: event.target.value })
                  }
                  placeholder="e.g. Always answer in the same language the user writes in."
                  className="min-h-[70px] text-sm"
                />
              </div>

              <div className="flex items-center gap-3">
                <Button
                  size="sm"
                  onClick={() => void save(assistant.audience)}
                  disabled={saving === assistant.audience}
                >
                  {saving === assistant.audience ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Save className="size-4" />
                  )}
                  Save
                </Button>
                {status[assistant.audience] && (
                  <span className="text-xs text-muted-foreground">
                    {status[assistant.audience]}
                  </span>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

/**
 * One skill row: the skill's own checkbox plus a checkbox per tool inside it.
 *
 * The tool checkboxes stay rendered while the skill is off, only disabled, so an
 * admin toggling a skill off and back on finds their tool selection intact
 * instead of silently reset.
 */
function SkillRow({
  skill,
  enabled,
  disabledTools,
  onToggleSkill,
  onToggleTool,
}: {
  skill: SkillInfo;
  enabled: boolean;
  disabledTools: Set<string>;
  onToggleSkill: () => void;
  onToggleTool: (toolName: string) => void;
}) {
  const liveTools = skill.tools.filter((tool) => !disabledTools.has(tool.name)).length;

  return (
    <div className="rounded-md border border-border p-2">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={enabled}
          onChange={onToggleSkill}
        />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{skill.name}</span>
          <span className="block text-xs text-muted-foreground">{skill.description}</span>
        </span>
      </label>

      <div className="mt-2 space-y-1 border-t border-border/60 pt-2 pl-6">
        {skill.tools.map((tool) => (
          <label
            key={tool.name}
            className={cn(
              "flex items-start gap-2 text-xs",
              enabled ? "cursor-pointer" : "cursor-not-allowed opacity-50"
            )}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-3.5 accent-primary"
              disabled={!enabled}
              checked={!disabledTools.has(tool.name)}
              onChange={() => onToggleTool(tool.name)}
            />
            <span className="min-w-0">
              <span className="block">{tool.label}</span>
              <span className="block font-mono text-[11px] text-muted-foreground">
                {tool.name}
              </span>
            </span>
          </label>
        ))}
        {enabled && liveTools === 0 && (
          <p className="text-[11px] text-muted-foreground">
            Every tool is switched off, so this skill will not load at all.
          </p>
        )}
      </div>
    </div>
  );
}

function NumberField({
  label,
  value,
  bound,
  step,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  bound: Bound | undefined;
  step?: number;
  /** Optional sentence under the input, for a setting whose effect isn't obvious. */
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-muted-foreground">
        {label}
        {bound && (
          <span className="ml-1 font-normal">
            ({bound.min}–{bound.max})
          </span>
        )}
      </label>
      <Input
        type="number"
        className="h-9"
        value={value}
        min={bound?.min}
        max={bound?.max}
        step={step ?? 1}
        onChange={(event) => {
          const next = Number(event.target.value);
          // Out-of-range values are clamped server-side too; keeping the raw
          // number here lets the admin type freely without the field fighting them.
          if (Number.isFinite(next)) onChange(next);
        }}
      />
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
