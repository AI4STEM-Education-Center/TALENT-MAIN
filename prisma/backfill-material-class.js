// Idempotent backfill: populate the MaterialClass join table from the legacy
// LearningMaterial.classId column. Safe to re-run (upsert). CommonJS so the
// production image can run it with plain `node` (the prod runner image does not
// bundle tsx).
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

// The deploy runs this right after `docker compose up -d`, which returns before
// the container entrypoint's `prisma db push` has finished applying the schema.
// Wait for the MaterialClass table to exist before backfilling — otherwise the
// run races the migration, throws "no such table", and (with no `set -e` in the
// deploy script) silently no-ops. This is why the first backfill never took.
async function waitForSchema(maxAttempts = 30, delayMs = 2000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await prisma.materialClass.count();
      return;
    } catch {
      console.log(`MaterialClass table not ready (attempt ${attempt}/${maxAttempts}); waiting ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error("MaterialClass table not available after waiting; aborting backfill.");
}

async function main() {
  await waitForSchema();
  console.log("Backfilling MaterialClass links from existing LearningMaterial.classId...");

  const materials = await prisma.learningMaterial.findMany({
    select: { id: true, classId: true },
  });

  let linked = 0;
  let skipped = 0;

  for (const m of materials) {
    if (!m.classId) {
      skipped++;
      continue;
    }
    await prisma.materialClass.upsert({
      where: { materialId_classId: { materialId: m.id, classId: m.classId } },
      create: { materialId: m.id, classId: m.classId },
      update: {},
    });
    linked++;
  }

  console.log(`Processed ${materials.length} materials: ${linked} linked, ${skipped} skipped (null classId).`);
  console.log("Backfill complete!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
