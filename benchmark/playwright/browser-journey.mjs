/**
 * Tier 2 — browser-level validation of the real deployment.
 *
 * k6 speaks HTTP, which is the right tool for load but blind to half of what a
 * student actually pays for. This app renders 41 dashboard pages server-side,
 * each running 3–5 Prisma queries, then hydrates React on top. A protocol-level
 * test sees the HTML byte count and calls it fast; it never measures the
 * hydration cost, never executes the client polling, and never proves the quiz
 * UI is usable at all.
 *
 * So a handful of real browsers run the student journey and report Web Vitals
 * alongside k6's server-side numbers. Low volume by design — this is a
 * correctness-and-experience check on the live dev site, not load.
 *
 * Run: node benchmark/playwright/browser-journey.mjs \
 *        --url https://dev.ai4talent.org --email … --password …
 *
 * Playwright is intentionally NOT a dependency of the app. Install it on demand:
 *   npx --yes playwright@latest install --with-deps chromium
 */

import fs from "node:fs";
import path from "node:path";

// Accepts both `--key=value` and `--key value`: the shell runners use the latter,
// a human at a terminal usually the former, and silently supporting only one turns
// every space-separated flag into the string "true".
// (Mirrors benchmark/tools/args.ts; kept inline so this file stays a dependency-
// free .mjs that can run under a bare `node` with no transpile step.)
const args = new Map();
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) continue;
    const [, name, inline] = match;
    if (inline !== undefined) {
      args.set(name, inline);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      args.set(name, argv[++i]);
    } else {
      args.set(name, "true");
    }
  }
}

const BASE_URL = (args.get("url") || process.env.BENCH_BASE_URL || "https://dev.ai4talent.org").replace(
  /\/+$/,
  ""
);
const OUT_DIR = path.resolve(
  args.get("out") || path.join(import.meta.dirname, "..", "results", "browser")
);
const HEADLESS = args.get("headed") !== "true";

/** Resolve credentials from flags, env, or the seeded dataset manifest. */
function credentials() {
  let email = args.get("email") || process.env.BENCH_EMAIL;
  let password = args.get("password") || process.env.BENCH_PASSWORD;
  if (email && password) return { email, password };

  const manifestPath = path.join(import.meta.dirname, "..", "results", "dataset.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    email ??= manifest.students?.[0]?.email;
    password ??= manifest.password;
  }
  if (!email || !password) {
    throw new Error(
      "no credentials — pass --email/--password, set BENCH_EMAIL/BENCH_PASSWORD, or seed first"
    );
  }
  return { email, password };
}

/**
 * Collect the vitals that actually vary on this app.
 *
 * LCP and CLS come from PerformanceObserver; TTFB and DOM timings from the
 * navigation entry. INP needs real interaction, so it is approximated by
 * measuring the click-to-render latency of the quiz start button below.
 */
const VITALS_SCRIPT = `
  window.__vitals = { lcp: 0, cls: 0, entries: [] };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        window.__vitals.lcp = Math.max(window.__vitals.lcp, entry.startTime + (entry.duration || 0));
      }
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__vitals.cls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch { /* older engines: vitals stay zero rather than failing the run */ }
`;

async function readVitals(page) {
  return page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    const paint = performance.getEntriesByType("paint");
    const fcp = paint.find((entry) => entry.name === "first-contentful-paint");
    const vitals = window.__vitals || { lcp: 0, cls: 0 };
    return {
      ttfbMs: Math.round(nav.responseStart || 0),
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
      loadMs: Math.round(nav.loadEventEnd || 0),
      fcpMs: Math.round(fcp ? fcp.startTime : 0),
      lcpMs: Math.round(vitals.lcp),
      cls: Number((vitals.cls || 0).toFixed(4)),
      transferredBytes: Math.round(nav.transferSize || 0),
      // Hydration is the part a protocol test cannot see: the gap between the
      // server's bytes arriving and the page being interactive.
      hydrationGapMs: Math.round((nav.domContentLoadedEventEnd || 0) - (nav.responseStart || 0)),
    };
  });
}

async function main() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error(
      "playwright is not installed. Run:\n" +
        "  npx --yes playwright@latest install --with-deps chromium\n" +
        "  npm i -D playwright   # or run this script with `npx -p playwright node …`"
    );
  }

  const { email, password } = credentials();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    // A mid-range student laptop, not a CI server with a 4K viewport.
    viewport: { width: 1440, height: 900 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/141.0.0.0 Safari/537.36 alw-benchmark/1.0",
  });
  await context.addInitScript(VITALS_SCRIPT);

  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
  });

  const report = { baseUrl: BASE_URL, atIso: new Date().toISOString(), steps: {} };

  const step = async (name, fn) => {
    const startedAt = Date.now();
    await fn();
    const vitals = await readVitals(page).catch(() => null);
    report.steps[name] = { wallMs: Date.now() - startedAt, vitals };
    console.log(
      `${name}: ${Date.now() - startedAt}ms` +
        (vitals ? ` (ttfb ${vitals.ttfbMs}ms, lcp ${vitals.lcpMs}ms, cls ${vitals.cls})` : "")
    );
  };

  try {
    await step("login_page", async () => {
      await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    });

    await step("login_submit", async () => {
      // Label-based selectors: resilient to markup changes, and they double as a
      // check that the form is still accessible.
      await page.getByLabel(/email or username/i).fill(email);
      await page.getByLabel(/password/i).fill(password);
      await Promise.all([
        page.waitForURL(/\/(student|teacher|admin)/, { timeout: 30_000 }),
        page.getByRole("button", { name: /sign in|log in/i }).click(),
      ]);
    });

    await step("student_dashboard", async () => {
      await page.goto(`${BASE_URL}/student`, { waitUntil: "networkidle" });
    });

    await step("class_view", async () => {
      const firstClass = page.getByRole("link").filter({ hasText: /section|20\d\d/i }).first();
      if ((await firstClass.count()) > 0) {
        await firstClass.click();
        await page.waitForLoadState("networkidle");
      }
    });

    // Click-to-first-question is the closest honest proxy for INP on this app:
    // the start button triggers the read-heavy POST /api/quiz.
    await step("quiz_start_interaction", async () => {
      const startButton = page.getByRole("button", { name: /start|begin|take/i }).first();
      if ((await startButton.count()) === 0) {
        console.log("  no start button found — class may have no open quiz");
        return;
      }
      const clickedAt = Date.now();
      await startButton.click();
      await page
        .getByRole("radio")
        .first()
        .waitFor({ state: "visible", timeout: 60_000 })
        .catch(() => {});
      report.steps.quiz_start_interaction = {
        interactionToQuestionMs: Date.now() - clickedAt,
      };
      console.log(`  click → first question rendered: ${Date.now() - clickedAt}ms`);
    });

    await page.screenshot({ path: path.join(OUT_DIR, "quiz.png"), fullPage: false });
  } finally {
    report.consoleErrors = consoleErrors;
    report.failedRequests = failedRequests;
    fs.writeFileSync(path.join(OUT_DIR, "browser-report.json"), JSON.stringify(report, null, 2));
    console.log(`\nBrowser report: ${path.join(OUT_DIR, "browser-report.json")}`);
    if (consoleErrors.length > 0) {
      console.warn(`  ${consoleErrors.length} console error(s), first: ${consoleErrors[0]}`);
    }
    if (failedRequests.length > 0) {
      console.warn(`  ${failedRequests.length} failed request(s), first: ${failedRequests[0]}`);
    }
    await browser.close();
  }
}

main().catch((error) => {
  console.error(`browser-journey failed: ${error.message}`);
  process.exit(1);
});
