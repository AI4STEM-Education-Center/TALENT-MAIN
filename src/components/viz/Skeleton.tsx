/**
 * Loading placeholders.
 *
 * A skeleton stands in for content that is coming, so it has to be the shape of
 * that content — a card-sized block where a card will land, three lines where a
 * paragraph will. A centred spinner tells the reader nothing about what they are
 * waiting for and makes the layout jump when it arrives.
 *
 * The shimmer is a background-position animation on a gradient, which the
 * compositor handles; the global prefers-reduced-motion rule stops it and leaves
 * a plain muted block, which is still a perfectly good placeholder.
 */

import { cn } from "@/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn("bg-muted", className)}
      style={{
        borderRadius: "calc(var(--radius) / 1.5)",
        backgroundImage:
          "linear-gradient(90deg, transparent 0%, hsl(var(--foreground) / 0.06) 50%, transparent 100%)",
        backgroundSize: "200% 100%",
        animation: "viz-shimmer 1.6s linear infinite",
      }}
      {...props}
    />
  );
}

/** A stat tile's silhouette: label line, big value, caption. */
export function StatTileSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("surface-card p-[var(--pad-card)]", className)}>
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-8 w-20" />
      <Skeleton className="mt-2 h-3 w-32" />
    </div>
  );
}

/** A paragraph's silhouette. The last line is short, as a real one would be. */
export function TextSkeleton({
  lines = 3,
  className,
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div
      className={cn("space-y-2", className)}
      role="status"
      aria-label="Loading"
    >
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          className="h-3"
          style={{ width: index === lines - 1 ? "62%" : "100%" }}
        />
      ))}
    </div>
  );
}
