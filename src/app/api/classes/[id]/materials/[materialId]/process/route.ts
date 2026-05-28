import { NextRequest, NextResponse } from "next/server";
import honker from "@russellthehippo/honker-node";
import path from "path";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; materialId: string }> }
) {
  const { materialId } = await params;
  
  // Resolve SQLite database path
  const dbUrl = process.env.DATABASE_URL || "file:./dev.db";
  let dbPath = dbUrl.replace("file:", "").split("?")[0];
  if (dbPath === "./dev.db") {
    dbPath = path.join(process.cwd(), "prisma", "dev.db");
  } else if (dbPath === "./data/prod.db") {
    dbPath = path.join(process.cwd(), "prisma", "data", "prod.db");
  } else if (!path.isAbsolute(dbPath)) {
    dbPath = path.join(process.cwd(), "prisma", dbPath);
  }

  // Open the Honker database connection and queue
  const db = honker.open(dbPath);
  const materialsQueue = db.queue("materials");

  // Enqueue the job for the background worker
  materialsQueue.enqueue({ materialId });
  
  return NextResponse.json({ status: "processing started" }, { status: 202 });
}
