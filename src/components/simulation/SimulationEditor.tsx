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
import { Loader2 } from "lucide-react";
import { GuardrailFeedbackButton } from "@/components/guardrails/GuardrailFeedbackButton";

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
  const { revising } = props;
  const {
    selected,
    versions,
    chat,
    plan,
    turns,
    current,
    busy,
    error,
    eventId,
    draft,
    act,
    update,
  } = editor;
  return (
    <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_360px]">
      <VersionPreview editor={editor} {...props} />
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
              What would you like to change? You can rewrite labels, add or
              remove functions, fix the science, or explore a different teaching
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
          {!revising && versions.length > 1 && (
            <p>
              Choose a version to inspect the result. What else would you like
              to change?
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
          disabled={busy || revising}
        />
        <Button
          disabled={busy || revising || !draft.trim()}
          onClick={() => act("chat", draft)}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}Send message
        </Button>
      </div>
    </div>
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
    textEdited,
    selectVersion,
    update,
  } = editor;
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
        Double-click text in the preview to edit it, then click outside it. Your
        text changes are added to the chat draft. Describe functions to add or
        remove in chat.
      </p>
      <div className="min-h-[320px] flex-1">
        <SimulationViewer
          key={`${selected}-${version}`}
          simulationId={id}
          title={current?.name ?? "Simulation"}
          version={version}
          selectedVersion={versions.length ? selected : undefined}
          onTextEdit={busy || revising ? undefined : textEdited}
        />
      </div>
      <div className="flex gap-2">
        <input
          aria-label="Version name"
          maxLength={80}
          value={rename}
          onChange={(e) => update({ rename: e.target.value })}
          placeholder={current?.name ?? "Version name"}
          className="min-w-0 flex-1 rounded border bg-background px-2 text-sm"
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
