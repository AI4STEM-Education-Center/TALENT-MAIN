"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SurveyFormView, type SurveyFormData } from "./SurveyFormView";

/** Fired by ConsentGate once a consent decision is saved, so the survey can follow. */
export const CONSENT_DECIDED_EVENT = "consent:decided";

const LATER_KEY = "survey-prompt-later";

type Due = {
  state: "DUE";
  mandatory: boolean;
  form: SurveyFormData;
  defaultEmail?: string;
};

/**
 * Mounted in the dashboard layout next to ConsentGate. Shows the enabled
 * pre-survey after the consent decision is on file:
 *
 * - Mandatory — a non-dismissible modal — for students and teachers who agreed
 *   to the IRB consent form (opted in to data collection). The server refuses
 *   to record a dismissal for them too.
 * - Optional for everyone else: a prompt they can take, postpone for this
 *   session ("Maybe later"), or decline for good ("No thanks").
 */
export function SurveyGate() {
  const { data: session, status: sessionStatus } = useSession();
  const role = session?.user?.role;
  const [due, setDue] = useState<Due | null>(null);
  const [taking, setTaking] = useState(false);
  const [done, setDone] = useState(false);

  const check = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch("/api/surveys/pre", {
        cache: "no-store",
        signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (signal?.aborted) return;
      if (data.state !== "DUE") {
        setDue(null);
        return;
      }
      if (!data.mandatory && sessionStorage.getItem(LATER_KEY) === data.form.id)
        return;
      setDue(data as Due);
      setTaking(Boolean(data.mandatory));
    } catch {
      // A transient failure just means no prompt this page load.
    }
  }, []);

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    if (role !== "STUDENT" && role !== "TEACHER") return;
    const controller = new AbortController();
    void check(controller.signal);
    const onConsent = () => void check(controller.signal);
    window.addEventListener(CONSENT_DECIDED_EVENT, onConsent);
    return () => {
      controller.abort();
      window.removeEventListener(CONSENT_DECIDED_EVENT, onConsent);
    };
  }, [sessionStatus, role, check]);

  if (!due || done) return null;

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
            {due.mandatory && (
              <p className="rounded-md bg-muted/60 p-3 text-sm text-muted-foreground">
                Because you agreed to take part in the research study, please
                complete this short survey before continuing.
              </p>
            )}
            <SurveyFormView
              form={due.form}
              interviewDefaultEmail={due.defaultEmail ?? ""}
              onSubmit={async (answers, interview) => {
                const res = await fetch("/api/surveys/pre", {
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
                setDone(true);
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
