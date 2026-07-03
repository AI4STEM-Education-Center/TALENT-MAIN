import { NextRequest, NextResponse } from "next/server";
import honker from "@russellthehippo/honker-node";
import { resolveQueueDbPath } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; materialId: string }> }
) {
  const { materialId } = await params;

  // Open the Honker queue (its own SQLite file, a sibling of the Prisma DB).
  const db = honker.open(resolveQueueDbPath());
  const materialsQueue = db.queue("materials");

  // Enqueue the job for the background worker
  materialsQueue.enqueue({ materialId });
  
  return NextResponse.json({ status: "processing started" }, { status: 202 });
}
