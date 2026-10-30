import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireAdminDataPage } from "@/lib/admin-access";
import { isAdmin } from "@/lib/roles";
import { isReplayArea } from "@/lib/session-recording";
import { SessionReplayPlayer } from "@/components/admin/session-replay-player";
import { DeleteRecordingButton } from "@/components/admin/delete-recording-button";

export default async function SessionReplayPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAdminDataPage();
  const { id } = await params;
  const requestedArea = (await searchParams).area;
  const initialArea = isReplayArea(requestedArea) ? requestedArea : null;
  const recording = await prisma.sessionRecording.findUnique({
    where: { id },
    select: {
      id: true,
      startedAt: true,
      entryPath: true,
      deviceType: true,
      viewportWidth: true,
      viewportHeight: true,
      eventCount: true,
      student: {
        select: {
          user: { select: { firstName: true, lastName: true, email: true } },
        },
      },
      chunks: { orderBy: { seq: "asc" }, select: { seq: true } },
    },
  });
  if (!recording) notFound();

  const { user } = recording.student;
  return (
    <div className="p-4 md:p-6 space-y-4">
      <Link
        href="/admin/session-replays"
        className="text-sm text-primary hover:underline"
      >
        ← All session replays
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">
            {user.firstName} {user.lastName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {user.email} · {recording.startedAt.toLocaleString()} ·{" "}
            <span className="capitalize">{recording.deviceType}</span> ·{" "}
            {recording.viewportWidth}×{recording.viewportHeight} · began on{" "}
            <span className="font-mono">{recording.entryPath}</span>
          </p>
        </div>
        {isAdmin(session.user.role) && (
          <DeleteRecordingButton recordingId={recording.id} />
        )}
      </div>
      {recording.chunks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This recording has no stored events.
        </p>
      ) : (
        <SessionReplayPlayer
          recordingId={recording.id}
          chunkSeqs={recording.chunks.map((chunk) => chunk.seq)}
          initialArea={initialArea}
          viewport={{
            width: recording.viewportWidth || 1280,
            height: recording.viewportHeight || 720,
          }}
        />
      )}
    </div>
  );
}
