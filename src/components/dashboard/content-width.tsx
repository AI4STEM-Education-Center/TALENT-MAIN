"use client";

import { createContext, use, useEffect } from "react";

/**
 * The dashboard layout caps every page at `max-w-7xl`. Views that temporarily
 * take over the whole viewport (e.g. exam results while a simulation is open)
 * use this context to ask the layout to lift that cap; the layout provides
 * the setter.
 */
export const SetContentFullWidthContext = createContext<(fullWidth: boolean) => void>(() => {});

/** Lifts the dashboard layout's content-width cap while `fullWidth` is true. */
export function useContentFullWidth(fullWidth: boolean) {
  const setFullWidth = use(SetContentFullWidthContext);
  useEffect(() => {
    if (!fullWidth) return;
    setFullWidth(true);
    return () => setFullWidth(false);
  }, [fullWidth, setFullWidth]);
}
