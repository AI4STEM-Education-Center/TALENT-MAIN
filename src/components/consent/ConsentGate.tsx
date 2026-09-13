"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { ConsentForm, type ConsentFormActiveVersion } from "./ConsentForm";

type GateStatus = "checking" | "clear" | "needs-decision" | "submitted";

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
 */
export function ConsentGate() {
  const { data: session, status: sessionStatus } = useSession();
  const [status, setStatus] = useState<GateStatus>("checking");
  const [activeForm, setActiveForm] = useState<ConsentFormActiveVersion | null>(null);

  const role = session?.user?.role;

  useEffect(() => {
    if (sessionStatus !== "authenticated") return;
    if (role !== "STUDENT" && role !== "TEACHER") {
      setStatus("clear");
      return;
    }

    let cancelled = false;
    fetch("/api/consent")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("status check failed"))))
      .then((data: { needsDecision: boolean; activeForm: ConsentFormActiveVersion | null }) => {
        if (cancelled) return;
        if (data.needsDecision && data.activeForm) {
          setActiveForm(data.activeForm);
          setStatus("needs-decision");
        } else {
          setStatus("clear");
        }
      })
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

  if (status !== "needs-decision" || !activeForm || (role !== "STUDENT" && role !== "TEACHER")) {
    return null;
  }

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
          onSubmitted={() => setStatus("submitted")}
        />
      </DialogContent>
    </Dialog>
  );
}
