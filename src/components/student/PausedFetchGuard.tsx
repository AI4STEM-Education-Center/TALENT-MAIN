"use client";

import { useEffect } from "react";
import { redirectIfPlatformPaused } from "@/lib/platform-paused";

/**
 * Sends a student to /student/paused when any API call answers with the
 * paused-platform 403 (`code: "PLATFORM_PAUSED"`), instead of every feature
 * showing its own raw error. Wraps window.fetch for the lifetime of the
 * dashboard layout rather than touching each caller. Only 403s are inspected
 * (on a clone), so every other response passes through untouched.
 */
export function PausedFetchGuard() {
  useEffect(() => {
    const original = window.fetch;
    const guarded: typeof window.fetch = async (...args) => {
      const res = await original.apply(window, args);
      if (res.status === 403) void redirectIfPlatformPaused(res);
      return res;
    };
    window.fetch = guarded;
    return () => {
      if (window.fetch === guarded) window.fetch = original;
    };
  }, []);
  return null;
}
