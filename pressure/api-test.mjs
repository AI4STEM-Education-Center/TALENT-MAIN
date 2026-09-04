#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  percentile,
  publishResult,
  saveResult,
  summarizeChecks,
} from "./lib/results.mjs";

const PRESSURE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.dirname(PRESSURE_DIR);
const targetUrl = (process.env.TARGET_URL || "https://dev.ai4talent.org").replace(/\/$/, "");
const profile = process.env.TEST_PROFILE || process.argv[2] || "critical";
if (!new Set(["critical", "full"]).has(profile)) {
  throw new Error("TEST_PROFILE must be 'critical' or 'full'");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

const accounts = {
  STUDENT: {
    login: required("DEV_TEST_STUDENT_LOGIN"),
    password: required("DEV_TEST_STUDENT_PASSWORD"),
  },
  TEACHER: {
    login: required("DEV_TEST_TEACHER_LOGIN"),
    password: required("DEV_TEST_TEACHER_PASSWORD"),
  },
  ADMIN: {
    login: required("DEV_TEST_ADMIN_LOGIN"),
    password: required("DEV_TEST_ADMIN_PASSWORD"),
  },
};

// react-doctor-disable-next-line react-doctor/no-impure-call-at-module-scope -- this is a one-shot Node CLI; process-start time is the run start, not render state
const started = new Date();
const runSuffix = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || "1"}`
  // react-doctor-disable-next-line react-doctor/no-impure-call-at-module-scope -- local CLI runs need a collision-resistant id generated once at process start
  : `${Date.now()}-${process.pid}`;
const runId = `api-${profile}-${runSuffix}`;
const checks = [];
const cleanupFailures = [];

function record(name, method, route, status, durationMs, outcome, detail) {
  checks.push({ name, method, route, status, durationMs, outcome, ...(detail ? { detail } : {}) });
  const mark = outcome === "PASS" ? "✓" : "✗";
  console.log(`${mark} ${name} (${method} ${route})${status ? ` -> ${status}` : ""} ${durationMs}ms`);
}

function responseDiagnostic(response, text) {
  const details = [];
  const server = response.headers.get("server");
  const edgeRequestId = response.headers.get("cf-ray");
  if (server) details.push(`server=${server}`);
  if (edgeRequestId) details.push(`cf-ray=${edgeRequestId}`);
  const body = text.replace(/\s+/g, " ").trim().slice(0, 300);
  if (body) details.push(`body=${body}`);
  return details.join("; ");
}

function retryDelayMs(attempt) {
  return Math.min(15_000, 1_000 * 2 ** (attempt - 1));
}

class HttpClient {
  constructor(name) {
    this.name = name;
    this.cookies = new Map();
  }

  absorbCookies(headers) {
    const values = typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
    for (const value of values) {
      const pair = value?.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (separator <= 0) continue;
      const name = pair.slice(0, separator);
      const cookieValue = pair.slice(separator + 1);
      if (cookieValue) this.cookies.set(name, cookieValue);
      else this.cookies.delete(name);
    }
  }

  async request(name, route, options = {}) {
    const method = options.method || "GET";
    const headers = new Headers(options.headers || {});
    if (this.cookies.size > 0) {
      headers.set("cookie", [...this.cookies].map(([key, value]) => `${key}=${value}`).join("; "));
    }
    if (options.json !== undefined) headers.set("content-type", "application/json");
    headers.set("user-agent", "ai4talent-api-test/1");
    const before = performance.now();
    const attempts = options.retry?.attempts || 1;
    const retryStatuses = new Set(options.retry?.statuses || []);
    let response;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      response = undefined;
      try {
        // react-doctor-disable-next-line react-doctor/no-fetch-response-used-without-status-check -- accepted status is checked below before response.text() is consumed
        response = await fetch(`${targetUrl}${route}`, {
          method,
          headers,
          body: options.json === undefined ? options.body : JSON.stringify(options.json),
          redirect: options.redirect || "manual",
          signal: AbortSignal.timeout(options.timeoutMs || 30_000),
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "request failed";
        if (options.retry?.onError && attempt < attempts) {
          const delayMs = retryDelayMs(attempt);
          console.warn(
            `↻ ${name} (${method} ${route}) -> ${detail}; retrying in ${delayMs}ms (${attempt}/${attempts})`,
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        const durationMs = Math.round((performance.now() - before) * 100) / 100;
        record(name, method, route, null, durationMs, "FAIL", detail);
        throw error;
      }
      if (!retryStatuses.has(response.status) || attempt === attempts) break;
      await response.body?.cancel();
      const delayMs = retryDelayMs(attempt);
      console.warn(
        `↻ ${name} (${method} ${route}) -> ${response.status}; retrying in ${delayMs}ms (${attempt}/${attempts})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (!response) throw new Error(`${name} did not receive a response`);
    const durationMs = Math.round((performance.now() - before) * 100) / 100;
    this.absorbCookies(response.headers);
    const allowed = options.allowed || ((status) => status >= 200 && status < 400);
    const accepted = typeof allowed === "function" ? allowed(response.status) : allowed.includes(response.status);
    const text = await response.text();
    if (!accepted) {
      const detail = responseDiagnostic(response, text);
      record(name, method, route, response.status, durationMs, "FAIL", detail);
      throw new Error(`${name} returned unexpected HTTP ${response.status}${detail ? ` (${detail})` : ""}`);
    }
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    record(name, method, route, response.status, durationMs, "PASS");
    return { response, body, durationMs };
  }
}

const anonymous = new HttpClient("anonymous");
const clients = {
  STUDENT: new HttpClient("student"),
  TEACHER: new HttpClient("teacher"),
  ADMIN: new HttpClient("admin"),
};

async function login(role) {
  const client = clients[role];
  const csrf = await client.request(`${role.toLowerCase()} csrf`, "/api/auth/csrf", {
    allowed: [200],
  });
  if (!csrf.body?.csrfToken) throw new Error(`${role} CSRF response did not contain a token`);
  const form = new URLSearchParams({
    csrfToken: csrf.body.csrfToken,
    identifier: accounts[role].login,
    password: accounts[role].password,
    remember: "false",
    callbackUrl: `${targetUrl}/`,
  });
  await client.request(`${role.toLowerCase()} login`, "/api/auth/callback/credentials", {
    method: "POST",
    body: form,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    allowed: (status) => status >= 200 && status < 400,
  });
  const session = await client.request(`${role.toLowerCase()} session`, "/api/auth/session", {
    allowed: [200],
  });
  if (session.body?.user?.role !== role) {
    throw new Error(`${role} account authenticated as ${session.body?.user?.role || "no role"}`);
  }
}

async function criticalChecks() {
  await anonymous.request("public landing", "/", {
    allowed: [200],
    // The container and edge route can become ready independently. Poll for up
    // to about one minute on connection errors or temporary HTTP responses,
    // but still fail a persistent host-validation, WAF, or app rejection.
    timeoutMs: 10_000,
    retry: {
      attempts: 8,
      onError: true,
      statuses: [403, 429, 502, 503, 504],
    },
  });
  await Promise.all([login("STUDENT"), login("TEACHER"), login("ADMIN")]);

  await Promise.all([
    clients.STUDENT.request("student profile", "/api/profile", { allowed: [200] }),
    clients.STUDENT.request("student classes", "/api/classes", { allowed: [200] }),
    clients.STUDENT.request("student notifications", "/api/notifications?take=1", { allowed: [200] }),
    clients.TEACHER.request("teacher profile", "/api/profile", { allowed: [200] }),
    clients.TEACHER.request("teacher classes", "/api/classes", { allowed: [200] }),
    clients.TEACHER.request("teacher quizzes", "/api/quizzes", { allowed: [200] }),
    clients.ADMIN.request("admin profile", "/api/profile", { allowed: [200] }),
    clients.ADMIN.request("admin stats", "/api/admin/stats", { allowed: [200] }),
    clients.ADMIN.request("admin resources", "/api/admin/resources?range=1h", { allowed: [200] }),
    clients.ADMIN.request("admin pressure history", "/api/admin/pressure-results?days=1&pageSize=1", {
      allowed: [200],
    }),
  ]);
}

function routeForFile(file) {
  return `/api/${path.relative(path.join(REPO_DIR, "src/app/api"), path.dirname(file)).split(path.sep).join("/")}`
    .replace(/\[\.\.\.[^\]]+\]/g, "__pressure_catchall__")
    .replace(/\[[^\]]+\]/g, "__pressure_missing__");
}

function discoverApiMethods(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name === "route.ts") files.push(absolute);
    }
  };
  walk(directory);
  return files.flatMap((file) => {
    const source = fs.readFileSync(file, "utf8");
    const methods = new Set(
      [...source.matchAll(/export\s+(?:(?:async\s+)?function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)]
        .map((match) => match[1])
    );
    if (source.includes("export const { GET, POST } = handlers")) {
      methods.add("GET");
      methods.add("POST");
    }
    return [...methods].map((method) => ({ file, route: routeForFile(file), method }));
  });
}

function clientForRead(route) {
  // Optional backup storage calls depend on external WebDAV/S3 state. Probe
  // their authorization boundary with a non-admin so the suite stays deterministic.
  if (route.startsWith("/api/admin/backup")) return clients.STUDENT;
  if (route.startsWith("/api/admin/")) return clients.ADMIN;
  if (route.startsWith("/api/student/")) return clients.STUDENT;
  if (
    route.startsWith("/api/classes") ||
    route.startsWith("/api/invitations") ||
    route.startsWith("/api/materials") ||
    route.startsWith("/api/pool-submissions") ||
    route.startsWith("/api/question") ||
    route.startsWith("/api/quizzes") ||
    route.startsWith("/api/topics") ||
    route.startsWith("/api/teacher/")
  ) return clients.TEACHER;
  return clients.STUDENT;
}

async function probeEveryRoute() {
  const endpoints = discoverApiMethods(path.join(REPO_DIR, "src/app/api"));
  if (endpoints.length < 100) throw new Error(`Only discovered ${endpoints.length} API methods; route scan is incomplete`);

  let accounted = 0;
  const probeErrors = [];
  for (const endpoint of endpoints) {
    // Auth.js's catch-all is covered by three real credential logins above; a
    // made-up catch-all action is not a meaningful endpoint check.
    if (endpoint.route.includes("__pressure_catchall__")) {
      record(`surface ${endpoint.method} ${endpoint.route}`, endpoint.method, endpoint.route, 0, 0, "PASS", "covered by login journey");
      accounted++;
      continue;
    }

    const isRead = endpoint.method === "GET" || endpoint.method === "HEAD";
    const isPublic = endpoint.route.startsWith("/api/auth/") || endpoint.route.startsWith("/api/invitations/");
    // Reads use the expected role. Mutations use the least-privileged student
    // session (or anonymous session for public routes) and invalid input. That
    // reaches user-scoped validation while admin/teacher handlers reject the
    // role, without changing production data. The fixture journey below covers
    // successful mutations through the normal APIs.
    const client = isRead ? clientForRead(endpoint.route) : isPublic ? anonymous : clients.STUDENT;
    try {
      await client.request(`surface ${endpoint.method} ${endpoint.route}`, endpoint.route, {
        method: endpoint.method,
        ...(isRead ? {} : { json: {} }),
        // 503 is a designed response when an optional assistant is disabled.
        allowed: (status) => (status < 500 || status === 503) && status !== 405,
        timeoutMs: 45_000,
      });
    } catch (error) {
      probeErrors.push(error instanceof Error ? error.message : String(error));
    }
    accounted++;
  }
  if (accounted !== endpoints.length) throw new Error(`Accounted for ${accounted}/${endpoints.length} API methods`);
  if (probeErrors.length > 0) {
    throw new Error(`${probeErrors.length}/${endpoints.length} API surface probes failed; first: ${probeErrors[0]}`);
  }
}

async function fixtureJourney() {
  const teacher = clients.TEACHER;
  const student = clients.STUDENT;
  const prefix = `pressure-${runSuffix}`.slice(0, 80);
  const created = { classId: null, quizId: null, topicId: null };

  try {
    const studentProfile = await student.request("fixture student identity", "/api/profile", { allowed: [200] });
    const profileData = studentProfile.body?.profile;
    if (!profileData?.email) throw new Error("Student profile has no email");
    const orgDefinedId = `${Date.now()}`.slice(-9);

    const topic = await teacher.request("create fixture topic", "/api/topics", {
      method: "POST",
      json: { name: `${prefix} topic`, contentType: "QUIZ", order: 9999 },
      allowed: [201],
    });
    created.topicId = topic.body?.id;

    const quiz = await teacher.request("create fixture quiz", "/api/quizzes", {
      method: "POST",
      json: { name: `${prefix} quiz`, topicId: created.topicId, order: 9999 },
      allowed: [201],
    });
    created.quizId = quiz.body?.id;

    await teacher.request("create fixture question", "/api/questions", {
      method: "POST",
      json: {
        text: "Pressure check: what is 2 + 2?",
        quizId: created.quizId,
        difficultyLevel: "BEGINNER",
        answerMode: "SINGLE_SELECT",
        options: [
          { text: "4", isCorrect: true },
          { text: "5", isCorrect: false },
        ],
      },
      allowed: [201],
      timeoutMs: 60_000,
    });
    await teacher.request("read fixture quiz", `/api/quizzes/${created.quizId}`, { allowed: [200] });
    await teacher.request("read fixture questions", `/api/questions?quizId=${created.quizId}`, { allowed: [200] });

    const newClass = await teacher.request("create fixture class", "/api/classes", {
      method: "POST",
      json: {
        name: `${prefix} class`,
        description: "Temporary automated API-test fixture; safe to delete.",
        studentList: [{
          orgDefinedId,
          firstName: profileData.firstName || "Pressure",
          lastName: profileData.lastName || "Student",
          email: profileData.email,
        }],
      },
      allowed: [201],
    });
    created.classId = newClass.body?.id;

    const invitation = await teacher.request("create fixture invitation", "/api/invitations", {
      method: "POST",
      json: { classId: created.classId, expiresInDays: 1, maxUses: 1 },
      allowed: [201],
    });
    const token = invitation.body?.token;
    if (!token) throw new Error("Invitation response has no token");
    await anonymous.request("read fixture invitation", `/api/invitations/${token}`, { allowed: [200] });
    await student.request("enroll fixture student", `/api/invitations/${token}`, {
      method: "POST",
      json: { orgDefinedId },
      allowed: [200],
    });

    await teacher.request("assign fixture quiz", `/api/classes/${created.classId}/quizzes`, {
      method: "POST",
      json: { quizId: created.quizId },
      allowed: [201],
    });
    await teacher.request("publish fixture quiz", `/api/classes/${created.classId}/quizzes`, {
      method: "PATCH",
      json: { quizId: created.quizId, published: true, maxAttempts: 1 },
      allowed: [200],
    });
    await teacher.request("read fixture class", `/api/classes/${created.classId}`, { allowed: [200] });
    await teacher.request("read fixture students", `/api/classes/${created.classId}/students`, { allowed: [200] });
    await student.request("student sees fixture class", `/api/classes/${created.classId}/quizzes`, { allowed: [200] });
    const attempt = await student.request("start fixture quiz", "/api/quiz", {
      method: "POST",
      json: { classId: created.classId, quizId: created.quizId },
      allowed: [200],
    });
    if (!attempt.body?.attemptId || attempt.body?.questions?.length !== 1) {
      throw new Error("Quiz start did not return the deterministic one-question fixture");
    }
  } finally {
    const cleanup = async (name, route, options) => {
      try {
        await teacher.request(name, route, options);
      } catch (error) {
        cleanupFailures.push(error instanceof Error ? error.message : String(error));
      }
    };
    if (created.classId) {
      await cleanup("cleanup fixture class", `/api/classes/${created.classId}`, { method: "DELETE", allowed: [200] });
    }
    if (created.quizId) {
      await cleanup("cleanup fixture quiz", `/api/quizzes/${created.quizId}`, { method: "DELETE", allowed: [200] });
    }
    if (created.topicId) {
      await cleanup("cleanup fixture topic", "/api/topics", {
        method: "DELETE",
        json: { id: created.topicId },
        allowed: [200],
      });
    }
  }
}

let fatalError = null;
try {
  await criticalChecks();
  if (profile === "full") {
    await fixtureJourney();
    await probeEveryRoute();
  }
} catch (error) {
  fatalError = error instanceof Error ? error.message : String(error);
  console.error(`API test failed: ${fatalError}`);
}

// react-doctor-disable-next-line react-doctor/no-impure-call-at-module-scope -- one-shot CLI completion time is intentionally captured after the suite finishes
const finished = new Date();
const failures = [
  ...checks.filter((check) => check.outcome === "FAIL"),
  ...cleanupFailures.map((detail) => ({ name: "fixture cleanup", detail })),
  ...(fatalError ? [{ name: "suite", detail: fatalError }] : []),
];
const durations = checks.filter((check) => check.status).map((check) => check.durationMs);
const checkSummary = summarizeChecks(checks);
const result = {
  schemaVersion: 1,
  runId,
  startedAt: started.toISOString(),
  finishedAt: finished.toISOString(),
  environment: process.env.TARGET_ENVIRONMENT || "dev",
  suite: `api-${profile}`,
  scenario: profile === "full" ? "all-endpoints-and-fixture" : "important-functions",
  status: failures.length === 0 ? "PASS" : "FAIL",
  source: process.env.GITHUB_ACTIONS === "true" ? "github-actions" : "local",
  commitSha: process.env.GITHUB_SHA || process.env.GIT_SHA || null,
  branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || process.env.GIT_BRANCH || null,
  targetUrl,
  durationMs: finished.getTime() - started.getTime(),
  totalChecks: checkSummary.totalChecks,
  passedChecks: checkSummary.passedChecks,
  failedChecks: checkSummary.failedChecks,
  latency: {
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    maxMs: durations.length ? Math.max(...durations) : null,
  },
  requestRate: checks.length / Math.max(1, (finished.getTime() - started.getTime()) / 1000),
  virtualUsers: 1,
  errorRate: checkSummary.errorRate,
  metadata: { profile, fixtureCleanupFailures: cleanupFailures.length },
  metrics: { checks },
  failures,
};

const output = process.env.RESULT_OUTPUT || path.join(PRESSURE_DIR, ".tmp", "api", `${runId}.json`);
console.log(`Result -> ${saveResult(result, output)}`);
try {
  await publishResult(result);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
if (result.status === "FAIL") process.exitCode = 1;
