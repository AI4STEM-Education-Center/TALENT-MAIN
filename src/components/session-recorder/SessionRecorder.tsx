"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { CONSENT_DECIDED_EVENT } from "@/components/survey/SurveyGate";
import { CUSTOM_TAG } from "@/lib/session-recording";
import { startSessionRecording, trackReplayEvent } from "./recorder";

/**
 * Records the student's visit for the research team's session replay (see
 * src/lib/session-recording.ts). Mounted once in the dashboard layout for
 * students only. It renders nothing.
 *
 * The server decides whether anyone is recorded: a student without research
 * consent gets a `no_consent` answer to the first upload, which stops the
 * recorder; it starts again when the consent modal reports a decision.
 */
export function SessionRecorder() {
  const pathname = usePathname();
  // Bumped to restart recording after consent is given mid-visit.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let waitForConsent: (() => void) | null = null;
    const stop = startSessionRecording((reason) => {
      if (reason !== "no_consent") return;
      const onDecided = () => {
        window.removeEventListener(CONSENT_DECIDED_EVENT, onDecided);
        waitForConsent = null;
        setAttempt((n) => n + 1);
      };
      window.addEventListener(CONSENT_DECIDED_EVENT, onDecided);
      waitForConsent = onDecided;
    });
    return () => {
      if (waitForConsent) {
        window.removeEventListener(CONSENT_DECIDED_EVENT, waitForConsent);
      }
      stop();
    };
  }, [attempt]);

  // rrweb only logs the URL in its opening snapshot; client-side navigations
  // need their own marker so the timeline can show where the student went.
  useEffect(() => {
    trackReplayEvent(CUSTOM_TAG.Navigate, { path: pathname });
  }, [pathname]);

  return null;
}
