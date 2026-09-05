import fs from "node:fs";
import path from "node:path";

function configuredSink(label, urlName, tokenName) {
  const baseUrl = process.env[urlName]?.trim();
  const token = process.env[tokenName]?.trim();
  if (!token) return null;
  if (!baseUrl) throw new Error(`${urlName} is required when ${tokenName} is configured`);
  return { label, url: new URL("/api/pressure-results", baseUrl).toString(), token };
}

export function resultSinks() {
  return [
    configuredSink("dev", "DEV_RESULTS_URL", "DEV_PRESSURE_RESULTS_TOKEN"),
    configuredSink("prod", "PROD_RESULTS_URL", "PROD_PRESSURE_RESULTS_TOKEN"),
  ].filter(Boolean);
}

export function saveResult(result, outputPath) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return resolved;
}

export async function publishResult(result) {
  const sinks = resultSinks();
  const required = new Set(
    (process.env.REQUIRED_RESULT_SINKS || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  if (sinks.length === 0) {
    if (process.env.REQUIRE_RESULT_PUBLISH === "true") {
      throw new Error("No result sink configured; set DEV_RESULTS_URL and DEV_PRESSURE_RESULTS_TOKEN");
    }
    console.log("No result sink configured; result remains local only.");
    return [];
  }

  const published = [];
  for (const sink of sinks) {
    try {
      const response = await fetch(sink.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sink.token}`,
          "content-type": "application/json",
          "user-agent": "ai4talent-pressure-runner/1",
        },
        body: JSON.stringify(result),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 500);
        throw new Error(`HTTP ${response.status}: ${body}`);
      }
      published.push(sink.label);
      console.log(`Published ${result.runId} to ${sink.label}.`);
    } catch (error) {
      const message = `Publishing to ${sink.label} failed: ${error instanceof Error ? error.message : error}`;
      if (required.has(sink.label)) throw new Error(message);
      console.warn(`${message} (optional sink; continuing)`);
    }
  }
  for (const label of required) {
    if (!published.includes(label)) throw new Error(`Required result sink '${label}' was not published`);
  }
  return published;
}

export function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return Math.round(sorted[Math.max(0, index)] * 100) / 100;
}

export function summarizeChecks(checks) {
  const passedChecks = checks.filter((check) => check.outcome === "PASS").length;
  const failedChecks = checks.filter((check) => check.outcome === "FAIL").length;
  const totalChecks = passedChecks + failedChecks;
  return {
    totalChecks,
    passedChecks,
    failedChecks,
    errorRate: totalChecks > 0 ? failedChecks / totalChecks : 1,
  };
}
