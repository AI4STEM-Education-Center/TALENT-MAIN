"use client";

/**
 * Sandboxed renderer for a simulation's HTML artifact. The document is served
 * by /api/simulations/[id]/content with a strict CSP; the sandbox attribute
 * (scripts only — no same-origin, forms, popups, or navigation) is the second
 * layer keeping AI-generated JS away from the app origin. Shared by the admin
 * dashboard, the teacher editor, and the student results view.
 */
export function SimulationViewer({
  simulationId,
  title,
  version,
}: {
  simulationId: string;
  title: string;
  /** Bump to bust the browser's private cache after a revision lands. */
  version?: number;
}) {
  return (
    <iframe
      src={`/api/simulations/${simulationId}/content${version ? `?v=${version}` : ""}`}
      title={title}
      sandbox="allow-scripts"
      className="h-full w-full rounded-md border bg-white"
    />
  );
}
