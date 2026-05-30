// One-time backfill: populate the MaterialClass join table from the legacy
// LearningMaterial.classId column. CommonJS so the production image can run it
// with plain `node` (the prod runner image does not bundle tsx).
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function main() {
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
