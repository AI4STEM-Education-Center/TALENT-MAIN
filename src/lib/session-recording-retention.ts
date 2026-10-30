import { prisma } from "./prisma";
import { RECORDING_RETENTION_DAYS } from "./session-recording";

/**
 * Delete session recordings whose last event is older than the retention
 * window. Chunks go with them (onDelete: Cascade). Returns the number of
 * recordings removed.
 */
export async function purgeExpiredSessionRecordings(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(
    now.getTime() - RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const { count } = await prisma.sessionRecording.deleteMany({
    where: { lastEventAt: { lt: cutoff } },
  });
  return count;
}
