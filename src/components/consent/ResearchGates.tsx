"use client";

import { useSession } from "next-auth/react";
import { ConsentGate } from "./ConsentGate";
import { SurveyGate } from "@/components/survey/SurveyGate";

/**
 * The research consent and survey modals, mounted once in the dashboard
 * layout. Keyed by the signed-in user, so every bit of per-user state (an
 * open prompt, the open-modal guard, retry timers) resets if the account
 * changes without a full reload.
 */
export function ResearchGates() {
  const { data: session } = useSession();
  const userId = session?.user?.id ?? "";
  return (
    <>
      <ConsentGate key={`consent:${userId}`} />
      <SurveyGate key={`survey:${userId}`} />
    </>
  );
}
