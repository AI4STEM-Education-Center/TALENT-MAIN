import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import { requireAdminDataPage } from "@/lib/admin-access";
import { searchValue, pageNumber } from "@/lib/admin-usage";
import {
  RECORDING_RETENTION_DAYS,
  REPLAY_AREAS,
  REPLAY_AREA_LABELS,
  formatOffset,
  isReplayArea,
} from "@/lib/session-recording";
import { areaWhere, parseAreas } from "@/lib/session-recording-server";

const PAGE_SIZE = 50;

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function SessionReplaysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireAdminDataPage();
  const params = await searchParams;
  const q = searchValue(params.q);
  const page = pageNumber(params.page);
  const requestedArea = searchValue(params.area);
  const area = isReplayArea(requestedArea) ? requestedArea : null;

  const studentWhere = q
    ? {
        student: {
          user: {
            OR: [
              { firstName: { contains: q } },
              { lastName: { contains: q } },
              { email: { contains: q } },
            ],
          },
        },
      }
    : {};
  const where = { ...studentWhere, ...areaWhere(area) };
  const [total, recordings] = await Promise.all([
    prisma.sessionRecording.count({ where }),
    prisma.sessionRecording.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        startedAt: true,
        lastEventAt: true,
        entryPath: true,
        deviceType: true,
        eventCount: true,
        byteCount: true,
        areas: true,
        student: {
          select: {
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
      },
    }),
  ]);

  const href = (nextPage: number, nextArea: string | null = area) =>
    `/admin/session-replays?${new URLSearchParams({
      q,
      page: String(nextPage),
      ...(nextArea ? { area: nextArea } : {}),
    })}`;

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Session replays</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Recordings of what consenting students did on the platform: mouse
          movement, clicks, scrolling, typing and the pages they visited,
          replayed in the real page with a timeline. Only students with research
          consent on file are recorded; staff never are, and passwords and the
          consent form are never captured. Recordings are deleted automatically
          after {RECORDING_RETENTION_DAYS} days.
        </p>
      </div>
      <nav aria-label="Part of the platform" className="flex flex-wrap gap-2">
        {[null, ...REPLAY_AREAS].map((value) => (
          <Button
            key={value ?? "all"}
            variant={area === value ? "default" : "outline"}
            size="sm"
            asChild
          >
            <Link href={href(1, value)} aria-current={area === value}>
              {value ? REPLAY_AREA_LABELS[value] : "All activity"}
            </Link>
          </Button>
        ))}
      </nav>
      <form
        className="flex flex-wrap items-end gap-3"
        action="/admin/session-replays"
      >
        {area && <input type="hidden" name="area" value={area} />}
        <label className="grid gap-1 text-sm">
          Student name or email
          <Input name="q" defaultValue={q} placeholder="Search students…" />
        </label>
        <Button type="submit">Search</Button>
        {q && (
          <Button variant="ghost" asChild>
            <Link
              href={
                area
                  ? `/admin/session-replays?area=${area}`
                  : "/admin/session-replays"
              }
            >
              Clear
            </Link>
          </Button>
        )}
      </form>
      <p className="text-sm text-muted-foreground">
        {total} recordings · page {page} of{" "}
        {Math.max(1, Math.ceil(total / PAGE_SIZE))}
      </p>
      <Card>
        <CardContent className="p-4 overflow-x-auto">
          {recordings.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground">
              No recordings match.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th className="p-2">Student</th>
                  <th className="p-2">Started</th>
                  <th className="p-2">Length</th>
                  <th className="p-2">Began on</th>
                  <th className="p-2">Parts</th>
                  <th className="p-2">Device</th>
                  <th className="p-2">Events</th>
                  <th className="p-2">Size</th>
                  <th className="p-2" />
                </tr>
              </thead>
              <tbody>
                {recordings.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 align-top">
                    <td className="p-2">
                      <span className="font-medium">
                        {row.student.user.firstName} {row.student.user.lastName}
                      </span>
                      <p className="text-xs text-muted-foreground">
                        {row.student.user.email}
                      </p>
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {row.startedAt.toLocaleString()}
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {formatOffset(
                        row.lastEventAt.getTime() - row.startedAt.getTime(),
                      )}
                    </td>
                    <td className="p-2 font-mono text-xs">{row.entryPath}</td>
                    <td className="p-2 text-xs">
                      {parseAreas(row.areas)
                        .map((value) => REPLAY_AREA_LABELS[value])
                        .join(", ") || "—"}
                    </td>
                    <td className="p-2 capitalize">{row.deviceType}</td>
                    <td className="p-2">{row.eventCount.toLocaleString()}</td>
                    <td className="p-2">{formatBytes(row.byteCount)}</td>
                    <td className="p-2">
                      <Button size="sm" asChild>
                        <Link
                          href={`/admin/session-replays/${row.id}${area ? `?area=${area}` : ""}`}
                        >
                          Replay
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <nav aria-label="Session replay pagination" className="flex gap-2">
        {page > 1 && (
          <Button variant="outline" asChild>
            <Link href={href(page - 1)}>Previous</Link>
          </Button>
        )}
        {page * PAGE_SIZE < total && (
          <Button variant="outline" asChild>
            <Link href={href(page + 1)}>Next</Link>
          </Button>
        )}
      </nav>
    </div>
  );
}
