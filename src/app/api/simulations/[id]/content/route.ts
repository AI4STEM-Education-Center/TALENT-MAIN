import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listSimulationVersions } from "@/lib/simulation-versions";
import { getS3ObjectAsString } from "@/lib/storage";
import { SIMULATION_CSP } from "@/lib/simulation";
import { renderSimulationLatex } from "@/lib/simulation-math";
import { injectTelemetryScript } from "@/lib/simulation-telemetry";
import { buildSimulationEditorLayer } from "@/lib/simulation-editor-script";

export const runtime = "nodejs";

/**
 * GET /api/simulations/[id]/content
 * Stream a simulation's HTML artifact from S3, locked down for rendering
 * inside <iframe sandbox="allow-scripts">: the CSP blocks every external
 * request and only our own pages may frame it. Never hand out a raw presigned
 * URL for these — S3 would serve the AI-generated document without this CSP.
 *
 * Access: admins always; teachers for their own quizzes and the pool; students
 * when they are enrolled in a class the quiz is assigned to (that is how the
 * simulation reaches them post-quiz).
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id }] = await Promise.all([auth(), params]);
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sim = await prisma.questionSimulation.findUnique({
    where: { id },
    include: {
      question: {
        select: { quizId: true, quiz: { select: { teacherId: true } } },
      },
    },
  });
  if (!sim) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { role } = session.user;
  let allowed = role === "ADMIN";
  if (!allowed && role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({
      where: { userId: session.user.id },
    });
    const ownerId = sim.question.quiz.teacherId;
    allowed = !!teacher && (ownerId === null || ownerId === teacher.id);
  } else if (!allowed && role === "STUDENT") {
    const student = await prisma.student.findUnique({
      where: { userId: session.user.id },
    });
    if (student) {
      const assignment = await prisma.classQuiz.findFirst({
        where: {
          quizId: sim.question.quizId,
          class: { enrollments: { some: { studentId: student.id } } },
        },
        select: { id: true },
      });
      allowed = !!assignment;
    }
  }
  if (!allowed)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!sim.storageKey || !sim.bucket) {
    return NextResponse.json(
      { error: "Simulation has no content yet" },
      { status: 409 },
    );
  }

  const selected = _req.nextUrl.searchParams.get("version");
  let storageKey = sim.storageKey;
  let bucket = sim.bucket;
  if (selected) {
    if (role !== "ADMIN" && role !== "TEACHER")
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    const number = Number(selected);
    if (!Number.isSafeInteger(number) || number < 1)
      return NextResponse.json({ error: "Invalid version" }, { status: 400 });
    const version = (await listSimulationVersions(sim)).find(
      (v) => v.number === number,
    );
    if (!version && number !== sim.version)
      return NextResponse.json({ error: "Version not found" }, { status: 404 });
    storageKey = version?.storageKey ?? sim.storageKey;
    bucket = version?.bucket ?? sim.bucket;
  }
  let html: string;
  try {
    html = await getS3ObjectAsString(bucket, storageKey);
  } catch (err) {
    console.error(`[Simulation] Failed to load artifact for ${sim.id}:`, err);
    return NextResponse.json(
      { error: "Failed to load simulation" },
      { status: 502 },
    );
  }

  const editing =
    (role === "ADMIN" || role === "TEACHER") &&
    _req.nextUrl.searchParams.get("edit") === "1";

  // Generated formula markers contain raw LaTeX. Parse them with KaTeX on the
  // server and emit self-contained MathML, so formulas render correctly inside
  // the no-network sandbox without shipping a runtime or external font assets.
  // Staff editing the document also get the LaTeX source kept on each formula:
  // MathML has no route back to it, and that is what the equation editor edits.
  html = renderSimulationLatex(html, { annotate: editing });
  if (editing) html += buildSimulationEditorLayer();

  // Students get the interaction-telemetry snippet injected at serve time (the
  // stored artifact is never modified, and pre-telemetry artifacts report like
  // new ones). It only postMessages cumulative counters to the parent viewer —
  // no network APIs, so it works under the strict CSP. Staff previews stay
  // byte-identical to the reviewed artifact.
  if (role === "STUDENT") html = injectTelemetryScript(html);

  return new NextResponse(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": SIMULATION_CSP,
      "X-Content-Type-Options": "nosniff",
      // The URL is authenticated and stable by simulation id while teachers can
      // publish a new artifact version. Never reuse an older response: immutable
      // raw vN objects may be CDN-cached, but this role-specific wrapper may not.
      "Cache-Control": "private, no-store",
    },
  });
}
