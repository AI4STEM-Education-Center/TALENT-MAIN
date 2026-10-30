export const DEFAULT_PAUSE_MESSAGE =
  "Access to the platform is paused for platform development. Please check back soon.";
export const PLATFORM_PAUSED_CODE = "PLATFORM_PAUSED";

export type PauseClass = {
  id: string;
  name: string;
  disabledAt: Date | null;
  disabledMessage: string | null;
};

/** No enrollments never pauses access. Any active enrollment preserves access. */
export function computeStudentPause(classes: readonly PauseClass[]) {
  const paused =
    classes.length > 0 && classes.every((cls) => cls.disabledAt !== null);
  const custom = classes
    .filter((cls) => cls.disabledAt !== null && cls.disabledMessage?.trim())
    .sort(
      (a, b) =>
        b.disabledAt!.getTime() - a.disabledAt!.getTime() ||
        a.id.localeCompare(b.id),
    )[0];
  return {
    paused,
    message: paused
      ? custom?.disabledMessage?.trim() || DEFAULT_PAUSE_MESSAGE
      : null,
    classes: classes.map((cls) => ({
      id: cls.id,
      name: cls.name,
      disabled: cls.disabledAt !== null,
    })),
  };
}

type PauseState = ReturnType<typeof computeStudentPause>;
const TTL_MS = 10_000;
// Shared by route and proxy bundles within a process. Other processes converge
// within TTL. Epoch prevents an in-flight pre-toggle query repopulating the cache.
const globalCache = globalThis as typeof globalThis & {
  classPauseCache?: {
    epoch: number;
    entries: Map<string, { expires: number; state: PauseState }>;
  };
};
const cache = (globalCache.classPauseCache ??= {
  epoch: 0,
  entries: new Map(),
});

export function invalidateStudentPauseCache() {
  cache.epoch++;
  cache.entries.clear();
}

/** Fail open on database failure; log it and never cache a failed lookup. */
export async function getStudentPause(userId: string): Promise<PauseState> {
  const now = Date.now();
  const hit = cache.entries.get(userId);
  if (hit && hit.expires > now) return hit.state;
  const epoch = cache.epoch;
  try {
    const { prisma } = await import("@/lib/prisma");
    const enrollments = await prisma.classEnrollment.findMany({
      where: { student: { userId } },
      select: {
        class: {
          select: {
            id: true,
            name: true,
            disabledAt: true,
            disabledMessage: true,
          },
        },
      },
      orderBy: { classId: "asc" },
    });
    const state = computeStudentPause(enrollments.map((row) => row.class));
    if (epoch === cache.epoch) {
      if (cache.entries.size >= 5000) cache.entries.clear();
      cache.entries.set(userId, { expires: now + TTL_MS, state });
    }
    return state;
  } catch (error) {
    const { logApiError } = await import("@/lib/system-log");
    logApiError("STUDENT_PAUSE_LOOKUP", error);
    return computeStudentPause([]);
  }
}

/** Archive rows have no live Class relation, so scope their reads by id. */
export async function getDisabledClassIds(): Promise<string[]> {
  const { prisma } = await import("@/lib/prisma");
  const classes = await prisma.class.findMany({
    where: { disabledAt: { not: null } },
    select: { id: true },
  });
  return classes.map((cls) => cls.id);
}
