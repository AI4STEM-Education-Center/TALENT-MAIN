import { prisma } from "@/lib/prisma";
import { logApiError } from "@/lib/system-log";
import { DEFAULT_PAUSE_MESSAGE } from "@/lib/platform-paused";

export {
  DEFAULT_PAUSE_MESSAGE,
  PLATFORM_PAUSED_CODE,
} from "@/lib/platform-paused";

export type PauseClass = {
  id: string;
  name: string;
  disabledAt: Date | null;
  disabledMessage: string | null;
};

/**
 * THE pause rule (change it here and nowhere else): a student is paused when
 * they are enrolled in at least one class and EVERY class they are enrolled in
 * is disabled. A student with no enrollments, or with any active class, keeps
 * platform access (content belonging to a disabled class is still hidden from
 * them by the per-class guards). The message is the custom message of the most
 * recently disabled class that has one, else the default.
 */
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

export type PauseState = ReturnType<typeof computeStudentPause>;

const TTL_MS = 10_000;
const MAX_ENTRIES = 5000;
// Held on globalThis because the proxy and the route handlers may be separate
// bundles in one process. Other processes converge within the TTL. The epoch
// stops a lookup that started before a toggle from repopulating the cache.
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

/** Drop every cached verdict. Called whenever an admin toggles a class. */
export function invalidateStudentPauseCache() {
  cache.epoch++;
  cache.entries.clear();
}

/**
 * Cached (10 s) pause state for a student user. FAILS OPEN: if the lookup
 * throws, the error is logged and the student is treated as not paused, so a
 * database blip never locks every student out; the failure is never cached.
 */
export async function getStudentPause(userId: string): Promise<PauseState> {
  const now = Date.now();
  const hit = cache.entries.get(userId);
  if (hit && hit.expires > now) return hit.state;
  const epoch = cache.epoch;
  try {
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
      if (cache.entries.size >= MAX_ENTRIES) cache.entries.clear();
      cache.entries.set(userId, { expires: now + TTL_MS, state });
    }
    return state;
  } catch (error) {
    logApiError("STUDENT_PAUSE_LOOKUP", error);
    return computeStudentPause([]);
  }
}

/** Archive rows have no live Class relation, so scope their reads by id. */
export async function getDisabledClassIds(): Promise<string[]> {
  const classes = await prisma.class.findMany({
    where: { disabledAt: { not: null } },
    select: { id: true },
  });
  return classes.map((cls) => cls.id);
}
