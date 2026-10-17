"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ConsentForm, type ConsentFormActiveVersion } from "./ConsentForm";
import { CONSENT_DECIDED_EVENT } from "@/components/survey/SurveyGate";

type GateStatus =
  | "checking"
  | "clear"
  | "needs-decision"
  | "reprompt"
  | "reprompt-form"
  | "submitted";

type Reprompt = { campaignKey: string; period: number };

/**
 * Mounted once in the dashboard layout (alongside its existing session
 * checks). Blocking, non-dismissible modal shown to a STUDENT or TEACHER who
 * hasn't yet recorded a decision on the currently active consent form for
 * their role — see docs/plans/consent-compliance-plan.md §2.
 *
 * Always does a fresh GET /api/consent on mount rather than trusting the
 * session JWT's consentDecision claim, so a form version an admin just
 * published takes effect on the very next page load instead of waiting for
 * the JWT to refresh at next sign-in.
 *
 * For a TEACHER, src/proxy.ts already redirects away from every /teacher/*
 * page before this would ever render — this modal is real enforcement only
 * for STUDENT (who is never blocked from navigating either way) and exists
 * as defense-in-depth for TEACHER during the brief window before a stale JWT
 * refreshes.
 *
 * Re-consent: when a new study period starts (an in-app post-survey is
 * prompting) a student who declined gets a separate, dismissible invitation
 * to reconsider. "Review consent form" opens the same form (a new decision is
 * recorded; the latest one wins everywhere); "No thanks" records a dismissal
 * for this period. Either way the SurveyGate is told to re-check, since it
 * holds back while this prompt is pending.
 */
export function ConsentGate() {
  const { data: session, status: sessionStatus } = useSession();
  const [status, setStatus] = useState<GateStatus>("checking");
  const [activeForm, setActiveForm] = useState<ConsentFormActiveVersion | null>(
    null,
  );
  const [reprompt, setReprompt] = useState<Reprompt | null>(null);

  const role = session?.user?.role;

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    if (role !== "STUDENT" && role !== "TEACHER") {
      setStatus("clear");
      return;
    }

    let cancelled = false;
    fetch("/api/consent")
      .then((res) =>
        res.ok ? res.json() : Promise.reject(new Error("status check failed")),
      )
      .then(
        (data: {
          needsDecision: boolean;
          activeForm: ConsentFormActiveVersion | null;
          reprompt?: Reprompt | null;
        }) => {
          if (cancelled) return;
          if (data.needsDecision && data.activeForm) {
            setActiveForm(data.activeForm);
            setStatus("needs-decision");
          } else if (data.reprompt && data.activeForm) {
            setActiveForm(data.activeForm);
            setReprompt(data.reprompt);
            setStatus("reprompt");
          } else {
            setStatus("clear");
          }
        },
      )
      .catch(() => {
        // Fail OPEN on a transient network error rather than locking a
        // student out of their whole dashboard over a blip — proxy.ts's
        // teacher hard-gate is the real backstop for TEACHER regardless.
        if (!cancelled) setStatus("clear");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionStatus, role]);

  if (!activeForm || (role !== "STUDENT" && role !== "TEACHER")) return null;

  const decided = () => {
    setStatus("submitted");
    // The surveys wait for the consent decision; let them follow.
    window.dispatchEvent(new Event(CONSENT_DECIDED_EVENT));
  };

  if (status === "reprompt" || status === "reprompt-form") {
    // Closing without choosing just hides it for this page view; it comes
    // back on the next load until they decide or say "No thanks".
    const close = () => setStatus("clear");
    const noThanks = async () => {
      setStatus("clear");
      await fetch("/api/consent/reprompt/dismiss", { method: "POST" }).catch(
        () => null,
      );
      window.dispatchEvent(new Event(CONSENT_DECIDED_EVENT));
    };
    return (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogContent
          className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogTitle className={status === "reprompt" ? "" : "sr-only"}>
            {status === "reprompt"
              ? "A new study period is starting"
              : "Research consent form"}
          </DialogTitle>
          {status === "reprompt" ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {reprompt?.period === 2
                  ? "The platform is being used for another study period. "
                  : ""}
                Earlier, you chose not to take part in the research study. Would
                you reconsider joining? Participation is voluntary and does not
                affect your grades or how you can use the platform.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => setStatus("reprompt-form")}>
                  Review consent form
                </Button>
                <Button variant="ghost" onClick={noThanks}>
                  No thanks
                </Button>
              </div>
            </div>
          ) : (
            <ConsentForm
              role={role}
              activeForm={activeForm}
              onSubmitted={decided}
            />
          )}
        </DialogContent>
      </Dialog>
    );
  }

  if (status !== "needs-decision") return null;

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">Research consent form</DialogTitle>
        <ConsentForm
          role={role}
          activeForm={activeForm}
          onSubmitted={decided}
        />
      </DialogContent>
    </Dialog>
  );
}
