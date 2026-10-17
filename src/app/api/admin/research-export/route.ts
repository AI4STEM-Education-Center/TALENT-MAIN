import { NextRequest, NextResponse } from "next/server";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { logDataExport, requireAdminDataReader } from "@/lib/admin-access";
import { createResearchExport } from "@/lib/research-export";
import { isAdmin } from "@/lib/roles";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  // Research scientists may download the dataset too; every download is
  // recorded in the audit log.
  const session = await requireAdminDataReader();
  if (session instanceof Response) return session;

  let cleanup: (() => Promise<void>) | undefined;
  const limited = rateLimit(req, "research-export", 2, 60_000, session.user.id);
  if (limited) return limited;
  try {
    // Admins get the full archive; a research scientist's leaves out the
    // deployment configuration they cannot see in the dashboard either.
    const audience = isAdmin(session.user.role) ? "admin" : "researcher";
    const result = await createResearchExport(session.user.id, req.signal, {
      audience,
    });
    cleanup = result.cleanup;
    const { size } = await stat(result.path);
    await logDataExport(session.user, "research export ZIP", {
      audience,
      filename: result.filename,
      bytes: size,
    });
    const stream = createReadStream(result.path, { signal: req.signal });
    stream.once("close", () => {
      void result
        .cleanup()
        .catch((error) =>
          console.error("Research export cleanup failed", error),
        );
    });
    return new NextResponse(
      Readable.toWeb(stream) as ReadableStream<Uint8Array>,
      {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${result.filename}"`,
          "Content-Length": String(size),
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  } catch (error) {
    await cleanup?.();
    console.error("Research export failed", error);
    return NextResponse.json(
      {
        error:
          "Could not create the research export. Please try again or check the server logs.",
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
