"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { usePathname } from "next/navigation";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SurveyFormView, type SurveyFormData } from "./SurveyFormView";
import { surveyFormLabel } from "@/lib/survey";

/** Fired by ConsentGate once a consent decision is saved, so the survey can follow. */
export const CONSENT_DECIDED_EVENT = "consent:decided";

const LATER_KEY = "survey-prompt-later";

/** Attempts per check, and the wait before each retry. */
const RETRY_DELAYS_MS = [0, 1_000, 3_000];

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms === 0 || signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

type Due = {
  state: "DUE";
  kind: "PRE" | "POST";
  period: number;
  mandatory: boolean;
  form: SurveyFormData;
  defaultEmail?: string;
};

/**
 * Mounted in the dashboard layout next to ConsentGate. Shows whichever survey
 * GET /api/surveys/due says is owed, one at a time, after any consent prompt:
 *
 * - The enabled pre-survey. Mandatory — a non-dismissible modal — for
 *   students and teachers who agreed to the IRB consent form (opted in to data
 *   collection); the server refuses to record a dismissal for them too.
 *   Optional for everyone else: a prompt they can take, postpone for this
 *   session ("Maybe later"), or decline for good ("No thanks").
 * - Then an in-app post-survey the admin is prompting for the current study
 *   period — always mandatory, and only for participants who were already in
 *   the study before the prompt started.
 *
 * Failure handling: like ConsentGate, this fails OPEN — an outage of the
 * survey API must not lock every student out of the platform. To keep one
 * failed request from skipping a mandatory survey for a whole session, each
 * check retries network errors and 5xx/429 responses with backoff, and the
 * check runs again on every client-side navigation (one cheap GET).
 */
export function SurveyGate() {
  const { data: session, status: sessionStatus } = useSession();
  const role = session?.user?.role;
  const [due, setDue] = useState<Due | null>(null);
  const [taking, setTaking] = useState(false);
  const pathname = usePathname();
  // Whether a modal is up, read by the navigation re-check (not a render input).
  const showing = useRef(false);
  useEffect(() => {
    showing.current = due !== null;
  }, [due]);

  const check = useCallback(async (signal?: AbortSignal) => {
    for (const delay of RETRY_DELAYS_MS) {
      await wait(delay, signal);
      if (signal?.aborted) return;
      try {
        const res = await fetch("/api/surveys/due", {
          cache: "no-store",
          signal,
        });
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) continue;
          return;
        }
        const data = await res.json();
        if (signal?.aborted) return;
        if (data.state !== "DUE") {
          setDue(null);
          return;
        }
        if (
          !data.mandatory &&
          sessionStorage.getItem(LATER_KEY) === data.form.id
        )
          return;
        setDue(data as Due);
        setTaking(Boolean(data.mandatory));
        return;
      } catch {
        if (signal?.aborted) return;
        // Network error: retry; after the last attempt, fail open until the
        // next navigation.
      }
    }
  }, []);

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    if (role !== "STUDENT" && role !== "TEACHER") return;
    const controller = new AbortController();
    if (!showing.current) void check(controller.signal);
    const onConsent = () => void check(controller.signal);
    window.addEventListener(CONSENT_DECIDED_EVENT, onConsent);
    return () => {
      controller.abort();
      window.removeEventListener(CONSENT_DECIDED_EVENT, onConsent);
    };
  }, [sessionStatus, role, check, pathname]);

  if (!due) return null;

  const later = () => {
    sessionStorage.setItem(LATER_KEY, due.form.id);
    setDue(null);
  };
  const decline = async () => {
    setDue(null);
    await fetch("/api/surveys/pre/dismiss", { method: "POST" }).catch(
      () => null,
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !due.mandatory) later();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={!due.mandatory}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          if (due.mandatory) e.preventDefault();
        }}
      >
        <DialogTitle className="sr-only">Platform survey</DialogTitle>
        {!taking ? (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">
              Help us improve the platform
            </h2>
            <p className="text-sm text-muted-foreground">
              Would you take a short survey about your background and experience
              with learning tools? It is for research purposes only, to improve
              the platform.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setTaking(true)}>Take the survey</Button>
              <Button variant="outline" onClick={later}>
                Maybe later
              </Button>
              <Button variant="ghost" onClick={decline}>
                No thanks
              </Button>
            </div>
          </div>
        ) : (
          <>
            {due.kind === "POST" ? (
              <p className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
                Before you continue, please complete the{" "}
                {surveyFormLabel(due.kind, due.period)} about your experience
                with the platform during this study period.
              </p>
            ) : (
              due.mandatory && (
                <p className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
                  Because you agreed to take part in the research study, please
                  complete this short survey before continuing.
                </p>
              )
            )}
            <SurveyFormView
              key={due.form.id}
              form={due.form}
              interviewDefaultEmail={
                due.kind === "PRE" ? (due.defaultEmail ?? "") : undefined
              }
              onSubmit={async (answers, interview) => {
                const res = await fetch("/api/surveys/due", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    formId: due.form.id,
                    answers,
                    interviewOptIn: interview?.optIn ?? false,
                    interviewEmail: interview?.email ?? "",
                  }),
                });
                const data = await res.json().catch(() => null);
                if (!res.ok)
                  return {
                    ok: false,
                    error: data?.error ?? "Could not submit the survey.",
                    questionId: data?.questionId,
                  };
                setDue(null);
                // Another survey may follow (e.g. a pre-survey, then the
                // current period's post-survey).
                void check();
                return { ok: true };
              }}
              footer={
                due.mandatory ? null : (
                  <Button variant="ghost" onClick={later}>
                    Finish later
                  </Button>
                )
              }
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
