#!/usr/bin/env tsx
/**
 * Live smoke test for the OpenAI Decisions API (POST /v1/decisions) used by
 * Wrong Answer Coach Check 2.
 *
 * Usage:
 *   npm run test:decisions:live
 *   OPENAI_API_KEY=sk-... npm run test:decisions:live -- --model gpt-6-luna
 *
 * When OPENAI_API_KEY is not set, resolves the active
 * `wrong_answer_coach_classify` provider from the local SQLite database.
 */

import { createDecisions } from "../src/lib/ai-decisions";
import {
  DEFAULT_AI_TIMEOUT_MS,
  resolveProvider,
  type ResolvedProvider,
} from "../src/lib/ai-provider";
import {
  aggregateCheck2Runs,
  mapDecisionChoiceToCheck2,
} from "../src/lib/wrong-answer-coach-rules";
import type { Check2RunSlot } from "../src/lib/wrong-answer-coach-types";

function parseArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

async function loadProvider(): Promise<ResolvedProvider> {
  const envKey = process.env.OPENAI_API_KEY?.trim();
  const modelArg = parseArg("--model") || process.env.DECISIONS_MODEL?.trim();
  const baseUrlArg =
    parseArg("--base-url") || process.env.OPENAI_BASE_URL?.trim() || null;

  if (envKey) {
    return {
      providerType: "openai",
      baseUrl: baseUrlArg,
      apiKey: envKey,
      model: modelArg || "gpt-6-luna",
      serviceTier: null,
      thinkingLevel: null,
      cfAigByokAlias: null,
      timeoutMs: DEFAULT_AI_TIMEOUT_MS,
      apiSurface: "responses",
    };
  }

  const resolved = await resolveProvider("wrong_answer_coach_classify");
  if (!resolved) {
    throw new Error(
      "No active 'wrong_answer_coach_classify' assignment in DB and OPENAI_API_KEY is unset.\n" +
        "Assign a provider in /admin/ai-config or pass OPENAI_API_KEY=sk-... npm run test:decisions:live",
    );
  }
  return modelArg ? { ...resolved, model: modelArg } : resolved;
}

async function main() {
  const provider = await loadProvider();
  console.log(
    `[Decisions Live Test] Provider=${provider.providerType} Model=${provider.model}`,
  );

  // 1. Single connectivity probe
  const probe = await createDecisions(provider, {
    model: provider.model,
    input:
      "Question: A ball is thrown straight up. At its highest point, what is its acceleration?\n" +
      "Correct answer: Downward at g.\n" +
      "Student explanation: Velocity is zero at the top, but gravity still pulls downward.",
    questions: [
      {
        name: "check2_probe",
        type: "choice",
        instructions:
          "Classify the explanation as 'sound' (correct physics), 'M12' (zero velocity means zero acceleration), or 'neither'.",
        choices: ["sound", "neither", "M12"],
      },
    ],
    store: false,
  });

  const probeAns = probe.answers[0];
  if (!probeAns || probeAns.type !== "choice") {
    throw new Error("Connectivity probe did not return a choice answer.");
  }
  console.log(
    `[Probe OK] choice=${probeAns.choice} confidence=${probeAns.confidence !== null ? probeAns.confidence.toFixed(3) : "n/a"} latency=${probe.latencyMs}ms`,
  );

  // 2. 5-run parallel Check 2 stability check
  const allowedCodes = ["M12", "M7"];
  const choices = ["sound", "neither", ...allowedCodes];
  const sampleInput =
    "Question: A ball is thrown straight up. At its highest point, what forces act on it?\n" +
    "Correct answer: Only gravity downward.\n" +
    "Known misconceptions:\n" +
    "- M12: A moving object requires a force in the direction of motion.\n" +
    "- M7: Zero velocity implies zero net force and zero acceleration.\n" +
    "Student explanation: The ball is still going up right before the top, so there must be an upward force pushing it.";

  const settled = await Promise.all(
    [0, 1, 2, 3, 4].map(async (runIndex): Promise<Check2RunSlot> => {
      const res = await createDecisions(provider, {
        model: provider.model,
        input: sampleInput,
        questions: [
          {
            name: "check2_classification",
            type: "choice",
            instructions:
              "Choose ONE label describing the student's explanation: 'sound', 'neither', or a listed misconception code ('M12', 'M7'). Judge only what the student wrote; if unsure choose 'neither'.",
            choices,
          },
        ],
        store: false,
      });
      const ans = res.answers[0];
      const choice = ans?.type === "choice" ? ans.choice : "";
      const mapped = mapDecisionChoiceToCheck2(choice, allowedCodes);
      return {
        runIndex,
        settled: true,
        valid: mapped.valid,
        retried: false,
        choice: choice || null,
        parsedKind: mapped.parsedKind,
        misconceptionCode: mapped.misconceptionCode,
        normalizedVoteKey: mapped.normalizedVoteKey,
        probabilities: ans?.type === "choice" ? ans.probabilities : [],
        confidence: ans?.type === "choice" ? ans.confidence : null,
        evidence: null,
        rawResponse: JSON.stringify(res.raw),
        model: res.model,
        latencyMs: res.latencyMs,
      };
    }),
  );

  const agg = aggregateCheck2Runs(settled);
  console.log("[5-Run Stability Check]");
  for (const r of settled) {
    console.log(
      `  Run ${r.runIndex + 1}: choice=${r.choice} conf=${r.confidence?.toFixed(3) ?? "n/a"} latency=${r.latencyMs}ms`,
    );
  }
  console.log(
    `[Result] outcome=${JSON.stringify(agg.outcome)} topVotes=${agg.topVoteCount}/5 meanConf=${agg.meanConfidence} flags=${JSON.stringify(agg.flags)}`,
  );
}

main().catch((err) => {
  console.error("[Decisions Live Test FAILED]", err instanceof Error ? err.message : err);
  process.exit(1);
});
