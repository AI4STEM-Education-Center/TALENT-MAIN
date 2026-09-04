#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function argument(name, fallback = null) {
  const equals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(equals.indexOf("=") + 1);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function resultFiles(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...resultFiles(resolved));
    else if (entry.name === "result.json") files.push(resolved);
  }
  return files;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function assessCapacity(results, requestedStudents) {
  const evidence = results
    .filter(
      (result) =>
        result?.suite === "pressure" && result?.scenario === "exam-day",
    )
    .map((result) => ({
      runId: result.runId,
      status: result.status,
      instanceType: result.metadata?.sutType,
      vcpus: numeric(result.metadata?.sutVcpus),
      memoryMiB: numeric(result.metadata?.sutMemoryMiB),
      students:
        numeric(result.metadata?.studentTarget) ?? numeric(result.virtualUsers),
      p95Ms: numeric(result.latency?.p95Ms),
      finishedAt: result.finishedAt,
    }))
    .filter((run) => run.instanceType && run.students);

  const byType = new Map();
  for (const run of evidence) {
    const current = byType.get(run.instanceType) ?? {
      instanceType: run.instanceType,
      vcpus: run.vcpus,
      memoryMiB: run.memoryMiB,
      highestPass: null,
      lowestFail: null,
      qualifyingPass: null,
    };
    current.vcpus ??= run.vcpus;
    current.memoryMiB ??= run.memoryMiB;
    if (run.status === "PASS") {
      if (!current.highestPass || run.students > current.highestPass.students)
        current.highestPass = run;
      if (
        run.students >= requestedStudents &&
        (!current.qualifyingPass ||
          run.students < current.qualifyingPass.students)
      ) {
        current.qualifyingPass = run;
      }
    } else if (
      !current.lowestFail ||
      run.students < current.lowestFail.students
    ) {
      current.lowestFail = run;
    }
    byType.set(run.instanceType, current);
  }

  const types = [...byType.values()].sort((a, b) => {
    const cpu =
      (a.vcpus ?? Number.MAX_SAFE_INTEGER) -
      (b.vcpus ?? Number.MAX_SAFE_INTEGER);
    if (cpu !== 0) return cpu;
    const memory =
      (a.memoryMiB ?? Number.MAX_SAFE_INTEGER) -
      (b.memoryMiB ?? Number.MAX_SAFE_INTEGER);
    return memory || a.instanceType.localeCompare(b.instanceType);
  });
  const proven = types.filter((type) => type.qualifyingPass);
  return {
    requestedStudents,
    evidenceCount: evidence.length,
    types,
    recommendation: proven[0] ?? null,
  };
}

function formatRun(run) {
  if (!run) return "not tested";
  const latency = run.p95Ms ? `, p95 ${Math.round(run.p95Ms)}ms` : "";
  return `${run.students} students${latency}`;
}

function main() {
  const requestedStudents = Number(argument("students"));
  if (!Number.isInteger(requestedStudents) || requestedStudents <= 0) {
    console.error(
      "Usage: ./run.sh recommend-size --students <positive whole number>",
    );
    process.exitCode = 2;
    return;
  }

  const root = path.resolve(
    argument("results-dir", path.join(import.meta.dirname, ".tmp/ec2-runs")),
  );
  const results = [];
  for (const file of resultFiles(root)) {
    try {
      results.push(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      console.warn(
        `Skipping unreadable result ${file}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const assessment = assessCapacity(results, requestedStudents);
  console.log(
    `EC2 capacity evidence for ${requestedStudents} concurrent exam-day students`,
  );
  console.log(`Results directory: ${root}`);
  if (assessment.types.length === 0) {
    console.log("\nNo student-count exam-day results are available yet.");
    console.log(
      `Collect one with: EC2_SUT_TYPE=<type> ./run.sh exam-day --students ${requestedStudents}`,
    );
    process.exitCode = 1;
    return;
  }

  console.log("");
  for (const type of assessment.types) {
    const hardware =
      type.vcpus && type.memoryMiB
        ? ` (${type.vcpus} vCPU, ${(type.memoryMiB / 1024).toFixed(1)} GiB)`
        : "";
    console.log(
      `${type.instanceType}${hardware}: highest PASS ${formatRun(type.highestPass)}; lowest FAIL ${formatRun(type.lowestFail)}`,
    );
  }

  if (!assessment.recommendation) {
    console.log(
      `\nNo tested instance type is proven at ${requestedStudents} students.`,
    );
    console.log(
      `Run: EC2_SUT_TYPE=<candidate> ./run.sh exam-day --students ${requestedStudents}`,
    );
    process.exitCode = 1;
    return;
  }

  const recommended = assessment.recommendation;
  console.log(
    `\nSmallest proven hardware shape in the current evidence: ${recommended.instanceType} ` +
      `(passed ${formatRun(recommended.qualifyingPass)}).`,
  );
  console.log(
    "This is a measured lower bound for the cloned dataset and exam-day workload, not a guarantee for untested traffic shapes.",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main();
