import { prisma } from "./prisma";
import {
  deleteS3Objects,
  getS3Config,
  getS3KeyPrefix,
  listS3Objects,
  listS3ObjectsWithMeta,
  quizExtractionPrefix,
} from "./storage";

// S3 garbage collector. Deletion flows in this app remove DB rows and rely on
// this collector to sweep the bucket afterwards: figure/option/simulation
// objects are SHARED by reference across deep-copied quizzes (see
// deepCopyQuiz), so the only safe delete is "no row anywhere references this
// key anymore" — which is exactly the reconciliation done here. The collector
// also discards abandoned extractions (tab closed mid-upload, never-reviewed
// failures) that no user action will ever clean up.
//
// Safety properties:
// - Only the three key families under this deployment's S3_KEY_PREFIX are ever
//   touched; another environment sharing the bucket remains invisible.
// - Objects younger than ORPHAN_GRACE_MS are never deleted, so an object
//   uploaded before its DB reference commits can't be swept mid-flight.
// - Every delete is best-effort: an S3 hiccup leaves orphans for the next run.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** An upload the client never finished; nothing can resume it. */
export const STALE_PENDING_UPLOAD_MS = DAY_MS;
/** EXTRACTING for a day = the worker died mid-job; the queue job is gone. */
export const STALE_EXTRACTING_MS = DAY_MS;
/** A failed extraction the teacher never retried or discarded. */
export const STALE_FAILED_MS = 7 * DAY_MS;
/** A review the teacher walked away from (the staged work is lost either way). */
export const STALE_AWAITING_REVIEW_MS = 30 * DAY_MS;
/** Never delete objects younger than this — their DB row may not exist yet. */
export const ORPHAN_GRACE_MS = DAY_MS;

/** Everything the reconciliation pass needs to know from the database. */
export type GcRefs = {
  /** Live LearningMaterial ids — a material's whole prefix lives or dies with its row. */
  materialIds: Set<string>;
  /** QuizPdfExtraction id → status, for the keep-whole-prefix rule pre-commit. */
  extractionStatusById: Map<string, string>;
  /** Question.figureStorageKey + Option.imageStorageKey (shared across quiz copies). */
  figureKeys: Set<string>;
  /** QuestionSimulation.storageKey + SimulationFeedback.previousStorageKey. */
  simulationKeys: Set<string>;
};

/**
 * Decide one object's fate against the DB reference sets. Pure so it's unit
 * testable; unknown or unparseable keys are always kept.
 */
export function classifyForGc(
  key: string,
  refs: GcRefs,
  keyPrefix = ""
): "keep" | "delete" {
  // Never classify an object outside this deployment's namespace. The caller
  // also scopes ListObjects to the prefix; this guard keeps the pure helper
  // safe if it is ever handed a mixed-environment object list.
  if (keyPrefix && !key.startsWith(keyPrefix)) return "keep";
  const managedKey = keyPrefix ? key.slice(keyPrefix.length) : key;
  const segments = managedKey.split("/");

  if (segments[0] === "learning-materials") {
    // learning-materials/{teacherId}/{classId}/{materialId}/...
    if (segments.length < 5) return "keep";
    return refs.materialIds.has(segments[3]) ? "keep" : "delete";
  }

  if (segments[0] === "quiz-extractions") {
    // quiz-extractions/{teacherId|pool}/{quizId}/{extractionId}/...
    if (segments.length < 5) return "keep";
    const status = refs.extractionStatusById.get(segments[3]);
    // A live, not-yet-committed extraction owns its whole prefix: staged
    // figure crops exist only in the extractedQuestions JSON, not as rows.
    if (status !== undefined && status !== "COMMITTED") return "keep";
    // Committed or row gone: only crops still referenced by a committed
    // Question/Option (possibly in a deep copy) survive. The PDF and page
    // rasters have served their purpose.
    return refs.figureKeys.has(key) ? "keep" : "delete";
  }

  if (segments[0] === "simulations") {
    // simulations/{teacherId|pool}/{quizId}/{questionId}/v{n}.html — exact
    // version files; anything unreferenced is a superseded or orphaned version.
    return refs.simulationKeys.has(key) ? "keep" : "delete";
  }

  // Not a family we manage (or a malformed key) — never touch it.
  return "keep";
}

/**
 * Load the reference sets the reconciliation pass compares the bucket against.
 * The queries run in ONE transaction so the refs are a consistent snapshot —
 * split reads could straddle an extraction commit and see status=COMMITTED
 * while missing its just-created question rows, dooming a live figure.
 */
export async function loadGcRefs(): Promise<GcRefs> {
  const [materials, extractions, questions, options, simulations, feedback] = await prisma.$transaction([
    prisma.learningMaterial.findMany({ select: { id: true } }),
    prisma.quizPdfExtraction.findMany({ select: { id: true, status: true } }),
    prisma.question.findMany({
      where: { figureStorageKey: { not: null } },
      select: { figureStorageKey: true },
    }),
    prisma.option.findMany({
      where: { imageStorageKey: { not: null } },
      select: { imageStorageKey: true },
    }),
    prisma.questionSimulation.findMany({
      where: { storageKey: { not: null } },
      select: { storageKey: true },
    }),
    prisma.simulationFeedback.findMany({
      where: { previousStorageKey: { not: null } },
      select: { previousStorageKey: true },
    }),
  ]);

  const figureKeys = new Set<string>();
  for (const q of questions) if (q.figureStorageKey) figureKeys.add(q.figureStorageKey);
  for (const o of options) if (o.imageStorageKey) figureKeys.add(o.imageStorageKey);

  const simulationKeys = new Set<string>();
  for (const s of simulations) if (s.storageKey) simulationKeys.add(s.storageKey);
  for (const f of feedback) if (f.previousStorageKey) simulationKeys.add(f.previousStorageKey);

  return {
    materialIds: new Set(materials.map((m) => m.id)),
    extractionStatusById: new Map(extractions.map((e) => [e.id, e.status])),
    figureKeys,
    simulationKeys,
  };
}

export type GcResult = {
  staleExtractionsDiscarded: number;
  orphanObjectsDeleted: number;
};

/**
 * Pass 1 — discard extractions no user action will ever finish: sweep each
 * one's S3 prefix, then delete the row (cascades its page rows). Mirrors the
 * teacher-facing discard endpoint, including its best-effort S3 stance.
 */
async function discardStaleExtractions(bucket: string, now: Date): Promise<number> {
  const cutoff = (ms: number) => new Date(now.getTime() - ms);
  const stale = await prisma.quizPdfExtraction.findMany({
    where: {
      OR: [
        { status: "PENDING_UPLOAD", updatedAt: { lt: cutoff(STALE_PENDING_UPLOAD_MS) } },
        { status: "EXTRACTING", updatedAt: { lt: cutoff(STALE_EXTRACTING_MS) } },
        { status: "FAILED", updatedAt: { lt: cutoff(STALE_FAILED_MS) } },
        { status: "AWAITING_REVIEW", updatedAt: { lt: cutoff(STALE_AWAITING_REVIEW_MS) } },
      ],
    },
    select: { id: true, status: true, storageKey: true, bucket: true },
  });

  let discarded = 0;
  for (const extraction of stale) {
    try {
      const keys = await listS3Objects(extraction.bucket || bucket, quizExtractionPrefix(extraction.storageKey));
      if (keys.length > 0) await deleteS3Objects(extraction.bucket || bucket, keys);
    } catch (e) {
      console.error(`[S3 GC] Sweep failed for stale extraction ${extraction.id}:`, e);
      // Leave the row so the objects are retried next run rather than orphaned.
      continue;
    }
    try {
      await prisma.quizPdfExtraction.delete({ where: { id: extraction.id } });
      discarded += 1;
      console.log(`[S3 GC] Discarded stale ${extraction.status} extraction ${extraction.id}`);
    } catch (e) {
      console.error(`[S3 GC] Could not delete stale extraction row ${extraction.id}:`, e);
    }
  }
  return discarded;
}

/**
 * Pass 2 — namespace-vs-DB reconciliation: list every object in the three
 * managed families under this deployment's prefix and delete the ones nothing
 * in its database references anymore. Because the check is per-object against
 * ALL references, it is safe under deep-copied quizzes sharing figure/
 * simulation keys, and its first run also clears older in-namespace orphans.
 */
async function reconcileBucket(bucket: string, now: Date): Promise<number> {
  const refs = await loadGcRefs();
  const graceCutoff = now.getTime() - ORPHAN_GRACE_MS;
  const keyPrefix = getS3KeyPrefix();

  const doomed: string[] = [];
  const families = ["learning-materials/", "quiz-extractions/", "simulations/"];
  const objectGroups = await Promise.all(
    families.map((family) => listS3ObjectsWithMeta(bucket, `${keyPrefix}${family}`))
  );
  for (const objects of objectGroups) {
    for (const obj of objects) {
      // No LastModified = can't prove it's old enough; leave it for next run.
      if (!obj.lastModified || obj.lastModified.getTime() > graceCutoff) continue;
      if (classifyForGc(obj.key, refs, keyPrefix) === "delete") doomed.push(obj.key);
    }
  }

  if (doomed.length > 0) {
    await deleteS3Objects(bucket, doomed);
    console.log(`[S3 GC] Deleted ${doomed.length} orphaned object(s)`);
  }
  return doomed.length;
}

/** Run both passes. Throws only if S3 is entirely unconfigured/unreachable. */
export async function runS3Gc(now: Date = new Date()): Promise<GcResult> {
  const { bucket } = getS3Config();
  const staleExtractionsDiscarded = await discardStaleExtractions(bucket, now);
  const orphanObjectsDeleted = await reconcileBucket(bucket, now);
  return { staleExtractionsDiscarded, orphanObjectsDeleted };
}
