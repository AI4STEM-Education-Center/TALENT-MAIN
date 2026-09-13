import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidEmail, normalizeEmail } from "@/lib/csv-roster";

// POST: Bulk-add students to an existing class roster from an uploaded CSV
// (teacher only). Expects { students: [{ orgDefinedId, firstName, lastName, email }] }.
// Rows with a duplicate 81 number (already on the roster, or repeated within the
// upload) are skipped rather than rejected, so re-uploading a fuller list is safe.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const cls = await prisma.class.findFirst({ where: { id, teacherId: teacher.id } });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const { students } = await req.json();
  if (!Array.isArray(students) || students.length === 0) {
    return NextResponse.json({ error: "No students were provided." }, { status: 400 });
  }

  // Normalize and validate. A single malformed row rejects the whole upload so
  // the teacher can fix the file rather than silently importing partial data.
  const seen = new Set<string>();
  const cleaned: { orgDefinedId: string; firstName: string; lastName: string; email: string }[] = [];
  for (const s of students) {
    const orgDefinedId = String(s?.orgDefinedId ?? "").replace(/^#/, "").trim();
    const firstName = String(s?.firstName ?? "").trim();
    const lastName = String(s?.lastName ?? "").trim();
    const email = normalizeEmail(s?.email);
    if (!orgDefinedId || !firstName || !lastName || !isValidEmail(email)) {
      return NextResponse.json(
        { error: "Every row needs an 81 number, first name, last name, and a valid email." },
        { status: 400 }
      );
    }
    if (seen.has(orgDefinedId)) continue; // de-dupe within the upload
    seen.add(orgDefinedId);
    cleaned.push({ orgDefinedId, firstName, lastName, email });
  }

  // Skip 81 numbers already on the roster (SQLite has no createMany skipDuplicates).
  const existing = await prisma.classStudentList.findMany({
    where: { classId: id, orgDefinedId: { in: cleaned.map((s) => s.orgDefinedId) } },
    select: { orgDefinedId: true },
  });
  const existingIds = new Set(existing.map((e) => e.orgDefinedId));
  const toAdd = cleaned.filter((s) => !existingIds.has(s.orgDefinedId));

  const result = await prisma.classStudentList.createMany({
    data: toAdd.map((s) => ({ ...s, classId: id })),
  });

  return NextResponse.json(
    { added: result.count, skipped: cleaned.length - result.count },
    { status: 201 }
  );
}
