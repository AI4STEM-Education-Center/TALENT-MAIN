"use client";
import { useState } from "react";
import {
  useSimulationEditor,
  type EditorProps,
  type EditorController,
  type Turn,
} from "./useSimulationEditor";
import type { SimulationEditPlan } from "@/lib/simulation-edit";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SimulationViewer } from "./SimulationViewer";
import { Loader2, Plus, Trash2, X } from "lucide-react";
import { GuardrailFeedbackButton } from "@/components/guardrails/GuardrailFeedbackButton";

const FIELD_CLASS =
  "min-w-0 flex-1 rounded border bg-background px-2 py-1 text-sm";

function displayTurn(turn: Turn) {
  if (turn.role === "user") return turn.content;
  try {
    return (JSON.parse(turn.content) as SimulationEditPlan).message;
  } catch {
    return turn.content;
  }
}
export function SimulationEditor(props: EditorProps) {
  const editor = useSimulationEditor(props);
  return (
    <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_360px]">
      <VersionPreview editor={editor} {...props} />
      <ChatPanel editor={editor} revising={props.revising} />
    </div>
  );
}

/**
 * Why the chat cannot answer, when it cannot. Both halves start empty on a
 * fresh install and live on different admin screens, so naming the missing one
 * is the difference between a two-minute fix and a bug report.
 */
function AssistantNotice({ editor }: { editor: EditorController }) {
  const { enabled, model } = editor.assistant;
  if (enabled && model) return null;
  return (
    <div role="status" className="rounded border border-dashed p-2 text-xs">
      <p className="font-medium">The editing chat is not set up yet.</p>
      <p className="mt-1 text-muted-foreground">
        An administrator needs to{" "}
        {!model && (
          <>
            assign a model to <strong>Simulation Editing Chat</strong> in Admin
            → AI Config
          </>
        )}
        {!model && !enabled && " and "}
        {!enabled && (
          <>
            turn on <strong>Simulation editing assistant</strong>
          </>
        )}
        . Direct text and equation edits in the preview still work meanwhile.
      </p>
    </div>
  );
}

function ChatPanel({
  editor,
  revising,
}: {
  editor: EditorController;
  revising: boolean;
}) {
  const {
    selected,
    chat,
    plan,
    turns,
    current,
    busy,
    error,
    eventId,
    draft,
    assistant,
    act,
    update,
  } = editor;
  const chatReady = assistant.enabled && !!assistant.model;
  return (
    <div className="flex min-h-0 flex-col gap-3 rounded border p-3">
      <p className="text-sm font-semibold">
        Edit v{selected} · {current?.name}
      </p>
      <p role="status" className="text-xs text-muted-foreground">
        {revising
          ? "Building and validating your revision… A new branch will appear here when ready."
          : busy
            ? "Reviewing your request…"
            : plan?.questions.length
              ? "Clarify the direction"
              : plan
                ? "Review the plan and create a version"
                : "Describe changes → refine → preview"}
      </p>
      <AssistantNotice editor={editor} />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          <GuardrailFeedbackButton eventId={eventId} />
        </p>
      )}
      <div
        role="log"
        aria-label="Simulation editing conversation"
        className="min-h-24 flex-1 space-y-3 overflow-y-auto text-sm"
      >
        {!turns.length && (
          <p>
            What would you like to change? You can rewrite labels, add or remove
            functions, fix the science, or explore a different teaching
            direction.
          </p>
        )}
        {turns.map((turn, i) => (
          <div
            key={`${chat?.id}-${i}`}
            className={`rounded p-2 ${turn.role === "user" ? "bg-accent" : "bg-muted"}`}
          >
            <strong>{turn.role === "user" ? "You" : "Editor"}</strong>
            <p className="whitespace-pre-wrap">{displayTurn(turn)}</p>
          </div>
        ))}
        {!revising && editor.versions.length > 1 && (
          <p>
            Choose a version to inspect the result. What else would you like to
            change?
          </p>
        )}
      </div>
      {!revising && plan && chat?.state === "DISCUSSING" && (
        <PlanChoices editor={editor} />
      )}
      {chat?.state === "THINKING" && (
        <Button variant="ghost" disabled={busy} onClick={() => act("abort")}>
          Abort pending conversation
        </Button>
      )}
      <label htmlFor="simulation-edit-message" className="text-sm">
        Your changes or feedback
      </label>
      <Textarea
        id="simulation-edit-message"
        value={draft}
        maxLength={4000}
        onChange={(e) => update({ draft: e.target.value })}
        placeholder="Change the title, remove the timer, add a speed slider…"
        rows={3}
        disabled={busy || revising || !chatReady}
      />
      <Button
        disabled={busy || revising || !chatReady || !draft.trim()}
        onClick={() => act("chat", draft)}
      >
        {busy && <Loader2 className="size-4 animate-spin" />}Send message
      </Button>
    </div>
  );
}

/**
 * Edits staged from the preview. They are applied straight to the artifact —
 * a rename or a corrected formula is something a teacher can state exactly, so
 * putting it through the revision model would only add a wait and a chance of
 * the model rewriting something nobody asked about. The escape hatch sends the
 * same list to the chat when a change turns out to need judgement after all.
 */
function StagedEdits({ editor }: { editor: EditorController }) {
  const { patches, busy, act, unstage, stageToDraft, describePatch } = editor;
  if (!patches.length) return null;
  return (
    <section className="space-y-2 rounded border p-2">
      <p className="text-sm font-medium">
        {patches.length} pending edit{patches.length > 1 ? "s" : ""}
      </p>
      <ul aria-label="Pending direct edits" className="space-y-1 text-xs">
        {patches.map((staged, i) => (
          <li key={staged.id} className="flex items-start gap-2">
            <span className="min-w-0 flex-1 break-words">
              {describePatch(staged.patch)}
            </span>
            <button
              aria-label={`Discard edit ${i + 1}`}
              disabled={busy}
              onClick={() => unstage(staged.id)}
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => act("patch")}>
          {busy && <Loader2 className="size-4 animate-spin" />}Apply as new
          version
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={stageToDraft}
        >
          Discuss in chat instead
        </Button>
      </div>
    </section>
  );
}

/**
 * Add, reword, or remove one of the document's LaTeX formulas. This lives in
 * the parent rather than the preview because KaTeX has already turned the
 * formula into MathML by the time it reaches the iframe, and there is no KaTeX
 * inside the sandbox to render an edit back.
 */
function EquationEditor({
  editor,
  focus,
}: {
  editor: EditorController;
  focus: number | null;
}) {
  const { formulas, busy, stage } = editor;
  const [editing, setEditing] = useState<{ index: number; latex: string }>();
  const [seenFocus, setSeenFocus] = useState<number | null>(null);
  const [added, setAdded] = useState({ latex: "", display: "block" });
  if (focus !== seenFocus) {
    setSeenFocus(focus);
    const target = focus === null ? undefined : formulas[focus];
    setEditing(target && { index: target.index, latex: target.latex });
  }
  return (
    <section className="space-y-2 rounded border p-2">
      <p className="text-sm font-medium">Equations</p>
      {!formulas.length && (
        <p className="text-xs text-muted-foreground">
          This version has no editable formula markers.
        </p>
      )}
      <ul aria-label="Equations" className="space-y-1">
        {formulas.map((formula) =>
          editing?.index === formula.index ? (
            <li key={formula.index} className="flex items-center gap-2">
              <input
                autoFocus
                aria-label={`LaTeX for equation ${formula.index + 1}`}
                className={`${FIELD_CLASS} font-mono`}
                maxLength={500}
                value={editing.latex}
                onChange={(e) =>
                  setEditing({ ...editing, latex: e.target.value })
                }
              />
              <Button
                size="sm"
                disabled={busy || !editing.latex.trim()}
                onClick={() => {
                  stage({
                    kind: "formula-edit",
                    index: formula.index,
                    latex: editing.latex,
                  });
                  setEditing(undefined);
                }}
              >
                Stage
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </Button>
            </li>
          ) : (
            <li key={formula.index} className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate text-xs">
                {formula.latex}
              </code>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  setEditing({ index: formula.index, latex: formula.latex })
                }
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove equation ${formula.index + 1}`}
                disabled={busy || formulas.length < 2}
                onClick={() =>
                  stage({ kind: "formula-delete", index: formula.index })
                }
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </li>
          ),
        )}
      </ul>
      <div className="flex items-center gap-2">
        <input
          aria-label="New equation LaTeX"
          className={`${FIELD_CLASS} font-mono`}
          maxLength={500}
          placeholder="E = K + U_s"
          value={added.latex}
          onChange={(e) => setAdded({ ...added, latex: e.target.value })}
        />
        <select
          aria-label="New equation placement"
          className="rounded border bg-background p-1 text-sm"
          value={added.display}
          onChange={(e) => setAdded({ ...added, display: e.target.value })}
        >
          <option value="block">Block</option>
          <option value="inline">Inline</option>
        </select>
        <Button
          size="sm"
          disabled={busy || !added.latex.trim() || formulas.length >= 8}
          onClick={() => {
            stage({
              kind: "formula-add",
              latex: added.latex,
              display: added.display === "inline" ? "inline" : "block",
            });
            setAdded({ latex: "", display: added.display });
          }}
        >
          <Plus className="size-4" />
          Add
        </Button>
      </div>
      {formulas.length >= 8 && (
        <p className="text-xs text-muted-foreground">
          A simulation shows at most 8 formulas — remove one first.
        </p>
      )}
    </section>
  );
}

function VersionPreview({
  editor,
  id,
  version,
  revising,
}: EditorProps & { editor: EditorController }) {
  const {
    selected,
    versions,
    current,
    busy,
    rename,
    act,
    stage,
    selectVersion,
    update,
  } = editor;
  const [focus, setFocus] = useState<number | null>(null);
  return (
    <div className="flex min-h-[360px] flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="simulation-version" className="text-sm font-medium">
          Preview / edit version
        </label>
        <select
          id="simulation-version"
          value={selected}
          disabled={busy}
          onChange={(e) => selectVersion(Number(e.target.value))}
          className="max-w-full rounded border bg-background p-2 text-sm"
        >
          {versions.map((v) => (
            <option key={v.number} value={v.number}>
              v{v.number} · {v.name}
              {v.parentNumber ? ` ← v${v.parentNumber}` : " · original"}
              {v.number === version ? " · live" : ""}
            </option>
          ))}
        </select>
        {selected !== version && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || revising}
            onClick={() => act("restore")}
          >
            Use this version
          </Button>
        )}
        {selected !== version && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => selectVersion(version)}
          >
            Show live v{version}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Double-click text in the preview to rewrite it, or a formula to open it
        below. Staged edits apply straight to a new version — describe new
        controls or a different teaching direction in chat.
      </p>
      <div className="min-h-[320px] flex-1">
        <SimulationViewer
          key={`${selected}-${version}`}
          simulationId={id}
          title={current?.name ?? "Simulation"}
          version={version}
          selectedVersion={versions.length ? selected : undefined}
          editable={!revising}
          onTextEdit={(before, after) => stage({ kind: "text", before, after })}
          onFormulaPick={setFocus}
        />
      </div>
      <StagedEdits editor={editor} />
      <EquationEditor editor={editor} focus={focus} />
      <div className="flex gap-2">
        <input
          aria-label="Version name"
          maxLength={80}
          value={rename}
          onChange={(e) => update({ rename: e.target.value })}
          placeholder={current?.name ?? "Version name"}
          className={FIELD_CLASS}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !rename.trim()}
          onClick={() => act("rename")}
        >
          Rename
        </Button>
      </div>
      <ol
        aria-label="Version branches"
        className="flex max-h-24 flex-wrap gap-2 overflow-y-auto text-xs"
      >
        {versions.map((v) => (
          <li key={v.number}>
            <button
              disabled={busy}
              onClick={() => selectVersion(v.number)}
              aria-current={v.number === selected ? "true" : undefined}
              className={`rounded border p-2 ${v.number === selected ? "bg-accent font-semibold" : ""}`}
            >
              {v.parentNumber ? `v${v.parentNumber} → ` : ""}v{v.number}{" "}
              {v.name}
              {v.number === version ? " (live)" : ""}
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
function PlanChoices({ editor }: { editor: EditorController }) {
  const { plan, selected, busy, answers, draft, act, update } = editor;
  if (!plan) return null;
  return (
    <div className="max-h-64 space-y-3 overflow-y-auto">
      {plan.questions.map((q) => (
        <fieldset key={q.question} className="space-y-1">
          <legend className="text-sm font-medium">{q.question}</legend>
          {[...q.options, "None of the above"].map((option) => (
            <Button
              key={option}
              size="sm"
              variant={answers[q.question] === option ? "default" : "outline"}
              className="mr-1 h-auto whitespace-normal text-left"
              disabled={busy}
              onClick={() =>
                update({ answers: { ...answers, [q.question]: option } })
              }
            >
              {option}
            </Button>
          ))}
        </fieldset>
      ))}
      {plan.questions.length > 0 && (
        <Button
          disabled={busy || plan.questions.some((q) => !answers[q.question])}
          onClick={() =>
            act(
              "chat",
              Object.entries(answers)
                .map(([q, a]) => `${q}: ${a}`)
                .join("\n") + (draft ? `\n${draft}` : ""),
            )
          }
        >
          Send answers
        </Button>
      )}
      {!plan.questions.length && plan.revisionPrompt && (
        <>
          <details>
            <summary className="cursor-pointer text-sm">
              Revision instructions · {plan.name}
            </summary>
            <p className="whitespace-pre-wrap text-xs">{plan.revisionPrompt}</p>
          </details>
          <Button disabled={busy} onClick={() => act("apply")}>
            Create “{plan.name}” from v{selected}
          </Button>
        </>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => act("abort")}
      >
        Abort this edit
      </Button>
    </div>
  );
}
