import { prisma } from "./prisma";
type SimulationArtifact = {
  id: string;
  version: number;
  title: string | null;
  storageKey: string | null;
  bucket: string | null;
  createdAt: Date;
};
/** Read legacy feedback snapshots as a linear history until immutable rows exist. */
export async function listSimulationVersions(sim: SimulationArtifact) {
  const versions = await prisma.simulationVersion.findMany({
    where: { simulationId: sim.id },
    orderBy: { number: "asc" },
    select: {
      number: true,
      name: true,
      parentNumber: true,
      storageKey: true,
      bucket: true,
      createdAt: true,
    },
  });
  if (versions.length || !sim.storageKey || !sim.bucket) return versions;
  const applied = await prisma.simulationFeedback.findMany({
    where: { simulationId: sim.id, status: "APPLIED" },
    orderBy: { createdAt: "asc" },
  });
  for (const [index, feedback] of applied.entries()) {
    const number = sim.version - applied.length + index;
    if (number > 0 && feedback.previousStorageKey)
      versions.push({
        number,
        name: `Version ${number}`,
        parentNumber: index > 0 ? number - 1 : null,
        storageKey: feedback.previousStorageKey,
        bucket: sim.bucket,
        createdAt: feedback.createdAt,
      });
  }
  versions.push({
    number: sim.version,
    name: sim.title ?? "Original",
    parentNumber: versions.at(-1)?.number ?? null,
    storageKey: sim.storageKey,
    bucket: sim.bucket,
    createdAt: sim.createdAt,
  });
  return versions;
}
/** Called only on edit, before changing a live pointer. Keeps all old artifacts. */
export async function snapshotSimulationVersions(sim: SimulationArtifact) {
  const versions = await listSimulationVersions(sim);
  for (const version of versions)
    await prisma.simulationVersion.upsert({
      where: {
        simulationId_number: { simulationId: sim.id, number: version.number },
      },
      update: {},
      create: { simulationId: sim.id, ...version },
    });
}
