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
 * Capture begins only after a fresh server consent check. Every consent decision
 * discards the old buffer and rechecks eligibility before restarting.
 */
export function SessionRecorder() {
  const pathname = usePathname();
  // Bumped to restart recording after consent is given mid-visit.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const onDecided = () => setAttempt((n) => n + 1);
    window.addEventListener(CONSENT_DECIDED_EVENT, onDecided);
    const stop = startSessionRecording(() => {});
    return () => {
      window.removeEventListener(CONSENT_DECIDED_EVENT, onDecided);
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
