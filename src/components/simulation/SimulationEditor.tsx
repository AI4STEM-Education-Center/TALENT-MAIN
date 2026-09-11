"use client";
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
import { Loader2, Pencil, X } from "lucide-react";
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
    <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto overflow-x-hidden lg:grid-cols-[minmax(0,1fr)_360px] lg:grid-rows-[minmax(0,1fr)] lg:overflow-hidden">
      <VersionPreview editor={editor} {...props} />
      <ChatPanel
        editor={editor}
        revising={props.revising}
        version={props.version}
      />
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
  version,
}: {
  editor: EditorController;
  revising: boolean;
  version: number;
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
    streaming,
    activity,
    assistant,
    act,
    update,
  } = editor;
  const chatReady = assistant.enabled && !!assistant.model;
  const canSend = !busy && !revising && chatReady && !!draft.trim();
  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-hidden rounded border p-3">
      <p className="text-sm font-semibold break-words">
        Edit v{selected} · {current?.name}
      </p>
      <p role="status" className="text-xs text-muted-foreground">
        {revising
          ? "Building and validating your revision… A new branch will appear here when ready."
          : busy
            ? (activity ?? "Reviewing your request…")
            : plan?.questions.length
              ? "Clarify the direction"
              : plan
                ? "Review the plan and create a version"
                : editor.versions.length > 1
                  ? "Pick a version above to inspect it, or describe another change"
                  : "Describe changes → refine → preview"}
      </p>
      <VersionDetails editor={editor} version={version} />
      <StagedEdits editor={editor} />
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
        className="min-h-24 flex-1 space-y-3 overflow-y-auto overflow-x-hidden text-sm"
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
            <p className="whitespace-pre-wrap break-words">
              {displayTurn(turn)}
            </p>
          </div>
        ))}
        {streaming && (
          <div className="rounded bg-muted p-2">
            <strong>Editor</strong>
            <p className="whitespace-pre-wrap break-words">{streaming}</p>
          </div>
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
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter writes a new line. `isComposing` keeps the
          // Enter that commits an IME candidate — Korean and Japanese input —
          // from sending a half-typed word.
          if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing)
            return;
          e.preventDefault();
          if (canSend) act("chat", draft);
        }}
        placeholder="Change the title, remove the timer, add a speed slider… (Enter to send, Shift+Enter for a new line)"
        rows={3}
        disabled={busy || revising || !chatReady}
      />
      <Button disabled={!canSend} onClick={() => act("chat", draft)}>
        {busy && <Loader2 className="size-4 animate-spin" />}Send message
      </Button>
    </div>
  );
}

/**
 * The batch a teacher has built up in edit mode. These apply straight to the
 * stored document — a rename or a corrected formula is something a teacher can
 * state exactly, so putting it through the revision model would only add a wait
 * and a chance of the model rewriting something nobody asked about. Structural
 * changes still belong in the chat.
 */
function StagedEdits({ editor }: { editor: EditorController }) {
  const { patches, busy, unstage, describePatch } = editor;
  if (!patches.length) return null;
  return (
    <section className="max-h-40 shrink-0 space-y-2 overflow-y-auto overflow-x-hidden rounded border p-2">
      <p className="text-sm font-medium">
        {patches.length} unsaved edit{patches.length > 1 ? "s" : ""}
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
    editing,
    patches,
    previewNonce,
    act,
    applyPreviewEdit,
    startEditing,
    cancelEditing,
    save,
    selectVersion,
  } = editor;
  return (
    <div className="flex min-h-0 flex-col gap-2">
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
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Button size="sm" disabled={busy || !patches.length} onClick={save}>
              {busy && <Loader2 className="size-4 animate-spin" />}Save{" "}
              {patches.length ? `${patches.length} edit` : "edits"}
              {patches.length > 1 ? "s" : ""}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={cancelEditing}
            >
              Cancel
            </Button>
            <p className="text-xs text-muted-foreground">
              Click any text or formula to edit it. Enter keeps a change, Escape
              undoes it. Hover a formula to add one after it or remove it.
            </p>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || revising}
              onClick={startEditing}
            >
              <Pencil className="size-4" />
              Edit
            </Button>
            <p className="text-xs text-muted-foreground">
              Rewrite labels and formulas directly. Describe new controls or a
              different teaching direction in chat.
            </p>
          </>
        )}
      </div>
      <div className="h-[70dvh] min-h-[320px] lg:h-auto lg:min-h-0 lg:flex-1">
        <SimulationViewer
          key={`${selected}-${version}-${previewNonce}`}
          simulationId={id}
          title={current?.name ?? "Simulation"}
          version={version}
          selectedVersion={versions.length ? selected : undefined}
          editable={!revising}
          editMode={editing}
          onPreviewEdit={applyPreviewEdit}
        />
      </div>
    </div>
  );
}
function VersionDetails({
  editor,
  version,
}: {
  editor: EditorController;
  version: number;
}) {
  const {
    rename,
    current,
    busy,
    versions,
    selected,
    update,
    act,
    selectVersion,
  } = editor;
  return (
    <details className="shrink-0 space-y-2 text-sm">
      <summary className="cursor-pointer">Version name and history</summary>
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
        className="flex max-h-24 flex-wrap gap-2 overflow-y-auto overflow-x-hidden text-xs"
      >
        {versions.map((v) => (
          <li key={v.number}>
            <button
              disabled={busy}
              onClick={() => selectVersion(v.number)}
              aria-current={v.number === selected ? "true" : undefined}
              className={`max-w-full whitespace-normal break-words rounded border p-2 text-left ${v.number === selected ? "bg-accent font-semibold" : ""}`}
            >
              {v.parentNumber ? `v${v.parentNumber} → ` : ""}v{v.number}{" "}
              {v.name}
              {v.number === version ? " (live)" : ""}
            </button>
          </li>
        ))}
      </ol>
    </details>
  );
}
/**
 * The proposal a teacher is being asked to accept. The planner either needs
 * decisions from them or it does not, and which of those it is has to be
 * legible without opening anything — an empty questions array used to render as
 * nothing at all, leaving two identical blue buttons and no way to tell whether
 * a choice was being withheld. The revision prompt runs to thousands of
 * characters, so it stays behind a disclosure; what the button will actually do
 * does not.
 */
function PlanChoices({ editor }: { editor: EditorController }) {
  const { plan, selected, busy, answers, draft, act, update } = editor;
  if (!plan) return null;
  const asking = plan.questions.length;
  const ready = !asking && !!plan.revisionPrompt;
  return (
    <section className="max-h-[45%] shrink-0 space-y-3 overflow-y-auto overflow-x-hidden rounded border p-2">
      <p className="text-sm font-medium">
        {asking
          ? `${asking} decision${asking > 1 ? "s" : ""} needed before this can run`
          : ready
            ? "No decisions needed — ready to build"
            : "Nothing to build yet — keep describing the change"}
      </p>
      {plan.questions.map((q) => (
        <fieldset key={q.question} className="space-y-1">
          <legend className="text-sm font-medium">{q.question}</legend>
          {[...q.options, "None of the above"].map((option) => (
            <Button
              key={option}
              size="sm"
              variant={answers[q.question] === option ? "default" : "outline"}
              className="mr-1 h-auto max-w-full whitespace-normal break-words text-left"
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
      {asking > 0 && (
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
      {ready && (
        <>
          <p className="text-sm">
            Builds a new version, <strong>“{plan.name}”</strong>, branching from
            v{selected}. v{selected} itself is not changed. This takes a few
            minutes; the new version joins the list when it is ready.
          </p>
          <details>
            <summary className="cursor-pointer text-sm">
              See exactly what will change
            </summary>
            <p className="whitespace-pre-wrap break-words text-xs">
              {plan.revisionPrompt}
            </p>
          </details>
          <Button
            className="h-auto w-full whitespace-normal break-words py-2"
            disabled={busy}
            onClick={() => act("apply")}
          >
            Create “{plan.name}”
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
    </section>
  );
}
