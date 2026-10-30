"use client";

import { useEffect } from "react";
import { CUSTOM_TAG, type ReplayArea } from "@/lib/session-recording";
import { trackReplayEvent } from "./recorder";

/**
 * Mark the time `active` is true as part of a replay area (simulation,
 * learning material, quiz). Pop-ups such as the simulation viewer or the
 * recommended-pages reader don't change the URL, so the page alone can't tell
 * the admin's per-area replay filter that the student is inside one. A no-op
 * when nothing is recording (staff, no consent).
 */
export function useReplayArea(area: ReplayArea, active = true): void {
  useEffect(() => {
    if (!active) return;
    trackReplayEvent(CUSTOM_TAG.Area, { area, state: "enter" });
    return () => trackReplayEvent(CUSTOM_TAG.Area, { area, state: "leave" });
  }, [area, active]);
}
