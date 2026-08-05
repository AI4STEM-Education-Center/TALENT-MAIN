/**
 * User journeys — the unit of load in this harness.
 *
 * Endpoint blasting ("50 connections against /api/classes") measures the
 * ceiling of one query. It cannot tell you whether a class of thirty students
 * can sit an exam, because it never reproduces the shape that actually hurts:
 * a burst of quiz starts, a long quiet stretch of think time, then a burst of
 * submissions all contending for SQLite's single write lock while teachers poll
 * stats and the worker drains AI jobs against the same database file.
 *
 * So every scenario in ../scenarios composes these instead.
 */

import http from "k6/http";
import { sleep } from "k6";
import { BASE_URL, THINK, thinkSeconds } from "./config.js";
import {
  record,
  resultReadyDuration,
  resultReadyTimeouts,
  journeyDuration,
} from "./metrics.js";

/** Common request options for an authenticated call. */
function authed(cookie, step, extra = {}) {
  return {
    headers: {
      cookie,
      "user-agent": "alw-benchmark/1.0 (k6)",
      accept: "*/*",
      ...(extra.headers || {}),
    },
    // Named tag so k6's URL grouping doesn't explode on per-VU ids.
    tags: { step, ...(extra.tags || {}) },
    timeout: extra.timeout || "60s",
    redirects: extra.redirects,
  };
}

/** GET a server-rendered page. TTFB dominates: these run 3–5 Prisma queries. */
function page(cookie, path, step) {
  const response = http.get(`${BASE_URL}${path}`, {
    ...authed(cookie, step, { headers: { accept: "text/html" } }),
    // A logged-out cookie 307s to /login, which would otherwise be recorded as
    // a success once the redirect is followed.
    redirects: 0,
  });
  record(step, response, { expect: [200] });
  return response;
}

// ─── Journey A — student quiz session (the dominant journey) ──────────────────

/**
 * Pick an answer without knowing the key.
 *
 * The quiz-start payload deliberately strips isCorrect / answerNumeric
 * (src/app/api/quiz/route.ts), so a VU answers the way a student does: a guess.
 * That is also what produces a realistic score spread, and therefore realistic
 * downstream work — a perfect attempt skips recommendation generation entirely
 * (exam-results-engine returns early when incorrectCount is 0), so a benchmark
 * that always answered correctly would never load the worker.
 */
function chooseAnswer(question) {
  const options = question.options || [];

  if (question.answerMode === "NUMERIC") {
    return { questionId: question.id, numericValue: Math.round(Math.random() * 10000) / 100 };
  }
  if (question.answerMode === "MULTI_SELECT") {
    const count = Math.max(1, Math.min(options.length, 1 + Math.floor(Math.random() * 2)));
    const shuffled = [...options].sort(() => Math.random() - 0.5);
    return {
      questionId: question.id,
      selectedOptionIds: shuffled.slice(0, count).map((option) => option.id),
    };
  }
  if (options.length === 0) return { questionId: question.id };
  return {
    questionId: question.id,
    selectedOptionId: options[Math.floor(Math.random() * options.length)].id,
  };
}

/**
 * Log in-adjacent browsing → start → answer with think time → submit → poll for
 * the AI result.
 *
 * @param identity  from config.studentIdentity()
 * @param options.browseFirst   include the SSR dashboard hops (default true)
 * @param options.answerThink   apply per-question think time (default true)
 * @param options.awaitResult   poll until the worker publishes the AI summary
 * @param options.resultTimeoutS how long to poll before recording a timeout
 */
export function studentQuizSession(identity, options = {}) {
  const {
    browseFirst = true,
    answerThink = true,
    awaitResult = true,
    resultTimeoutS = 90,
  } = options;
  const startedAt = Date.now();
  const { cookie, classId, quizIds } = identity;

  if (browseFirst) {
    page(cookie, "/student", "page_student_dashboard");
    sleep(thinkSeconds(THINK.navigationS));
    page(cookie, `/student/classes/${classId}`, "page_class_view");
    // The sidebar badge polls this on every dashboard view.
    record(
      "notifications",
      http.get(`${BASE_URL}/api/notifications?take=20`, authed(cookie, "notifications"))
    );
    sleep(thinkSeconds(THINK.navigationS));
  }

  const quizId = quizIds[Math.floor(Math.random() * quizIds.length)];

  // Start. This is the read-heavy half: the full question set plus a presigned
  // URL per figure and per image option.
  const startResponse = http.post(
    `${BASE_URL}/api/quiz`,
    JSON.stringify({ classId, quizId }),
    authed(cookie, "quiz_start", { headers: { "content-type": "application/json" } })
  );
  if (!record("quiz_start", startResponse, { expect: [200] })) return null;

  let payload;
  try {
    payload = startResponse.json();
  } catch {
    return null;
  }
  const questions = payload.questions || [];
  if (!payload.attemptId || questions.length === 0) return null;

  const answers = [];
  for (const question of questions) {
    answers.push(chooseAnswer(question));
    if (answerThink) sleep(thinkSeconds(THINK.perQuestionS));
  }

  // Submit. This is the write-heavy half, and the one that serializes: a claim,
  // a createMany of every answer row, a progress upsert, then an ExamResult
  // insert and a queue enqueue — all under one write lock.
  const submitResponse = http.patch(
    `${BASE_URL}/api/quiz`,
    JSON.stringify({ attemptId: payload.attemptId, answers }),
    authed(cookie, "quiz_submit", { headers: { "content-type": "application/json" } })
  );
  // 403 is the attempt cap and 409 the one-shot claim: both are correct
  // behaviour, so they are recorded as designed rather than as failures.
  const submitted = record("quiz_submit", submitResponse, { expect: [200] });

  if (submitted && awaitResult) {
    awaitExamResult(cookie, payload.attemptId, resultTimeoutS);
  }

  journeyDuration.add(Date.now() - startedAt, { journey: "student_quiz" });
  return payload.attemptId;
}

/**
 * Poll the results endpoint the way the results page does.
 *
 * This is the only end-to-end measurement of the background worker: whether it
 * drains the exam-results queue while the web tier is under load, or falls
 * behind so far that students never see their summary.
 */
export function awaitExamResult(cookie, attemptId, timeoutS = 90) {
  const startedAt = Date.now();
  const deadline = startedAt + timeoutS * 1000;
  // Matches the results UI's cadence closely enough to reproduce its load.
  const intervalS = 3;

  for (;;) {
    const response = http.get(
      `${BASE_URL}/api/student/attempts/${attemptId}/results`,
      authed(cookie, "result_poll")
    );
    // 404 is expected for a beat: the ExamResult row is written after the
    // grading transaction commits.
    record("result_poll", response, { expect: [200, 404] });

    if (response.status === 200) {
      let body;
      try {
        body = response.json();
      } catch {
        body = null;
      }
      if (body && body.summaryStatus && body.summaryStatus !== "PENDING" && body.summaryStatus !== "GENERATING") {
        resultReadyDuration.add(Date.now() - startedAt);
        return body.summaryStatus;
      }
    }

    if (Date.now() >= deadline) {
      resultReadyTimeouts.add(1);
      return null;
    }
    sleep(intervalS);
  }
}

// ─── Journey B — teacher monitoring ──────────────────────────────────────────

/**
 * A teacher watching a live quiz. The stats and grades-export endpoints
 * aggregate across every attempt in the class, so their cost grows with the
 * dataset — which is why the seed builds a term of history.
 */
export function teacherMonitoring(identity, options = {}) {
  const { cookie, classes } = identity;
  const { includeExport = true } = options;
  const startedAt = Date.now();

  page(cookie, "/teacher", "page_teacher_dashboard");
  sleep(thinkSeconds(THINK.navigationS));

  const target = classes[Math.floor(Math.random() * classes.length)];
  if (!target || target.quizIds.length === 0) return;
  const quizId = target.quizIds[Math.floor(Math.random() * target.quizIds.length)];

  page(cookie, `/teacher/classes/${target.classId}`, "page_teacher_class");
  sleep(thinkSeconds(THINK.navigationS));

  record(
    "quiz_stats",
    http.get(
      `${BASE_URL}/api/classes/${target.classId}/quizzes/${quizId}/stats`,
      authed(cookie, "quiz_stats")
    )
  );
  sleep(thinkSeconds(THINK.reviewS));

  if (includeExport) {
    record(
      "grades_export",
      http.get(
        `${BASE_URL}/api/classes/${target.classId}/quizzes/${quizId}/grades-export?mode=best-attempt&maxPoints=100`,
        authed(cookie, "grades_export")
      )
    );
  }

  // The quiz editor polls its question list every 5s while open.
  record(
    "questions_poll",
    http.get(`${BASE_URL}/api/questions?quizId=${quizId}`, authed(cookie, "questions_poll"))
  );

  journeyDuration.add(Date.now() - startedAt, { journey: "teacher_monitoring" });
}

// ─── Journey C — admin / background floor ────────────────────────────────────

/**
 * The load an open admin tab generates whether or not anyone is looking at it:
 * the materials page re-fetches every 2 seconds. Cheap per request, but it is a
 * constant floor on a single-process server, and leaving it out of the model
 * flatters every other number.
 */
export function adminPolling(identity) {
  const { cookie } = identity;
  record("admin_stats", http.get(`${BASE_URL}/api/admin/stats`, authed(cookie, "admin_stats")));
  record(
    "admin_materials",
    http.get(`${BASE_URL}/api/admin/materials`, authed(cookie, "admin_materials"))
  );
  record(
    "admin_logs",
    http.get(`${BASE_URL}/api/admin/logs?take=50`, authed(cookie, "admin_logs"))
  );
}

// ─── Journey F — login (measured deliberately, never incidentally) ───────────

/**
 * One full credentials login: CSRF fetch, then the callback that runs a cost-12
 * bcryptjs compare.
 *
 * Kept out of every other journey on purpose. bcrypt is the most expensive
 * single operation in the app, and src/lib/auth.ts throttles to 10/min/IP — so
 * logging in per iteration would measure the limiter and swamp the endpoint
 * under test. Exam day does start with thirty simultaneous logins though, which
 * is why scenarios/login-storm.js exists to measure exactly this.
 *
 * @param spreadIp send a distinct synthetic X-Forwarded-For, to measure bcrypt
 *                 cost without the limiter truncating the run. Leave false to
 *                 measure the limiter itself.
 */
export function login(email, password, options = {}) {
  const { spreadIp = false, ordinal = 0 } = options;
  const headers = { "user-agent": "alw-benchmark/1.0 (k6)" };
  if (spreadIp) {
    const n = ordinal % 65536;
    // RFC 2544 benchmarking range — never routable, so it can't be mistaken for
    // a real client address in the app's auth logs.
    const ip = `198.18.${Math.floor(n / 256)}.${n % 256}`;
    headers["x-forwarded-for"] = ip;
    headers["x-real-ip"] = ip;
  }

  const jar = http.cookieJar();
  const csrfResponse = http.get(`${BASE_URL}/api/auth/csrf`, {
    headers,
    tags: { step: "login_csrf" },
  });
  if (!record("login_csrf", csrfResponse, { expect: [200] })) return null;

  let csrfToken;
  try {
    csrfToken = csrfResponse.json().csrfToken;
  } catch {
    return null;
  }

  const loginResponse = http.post(
    `${BASE_URL}/api/auth/callback/credentials`,
    { identifier: email, password, csrfToken, callbackUrl: `${BASE_URL}/`, json: "true" },
    { headers, tags: { step: "login" }, redirects: 0 }
  );
  // 302 is a successful sign-in; 401/429 are the designed rejections.
  record("login", loginResponse, { expect: [200, 302] });

  const cookies = jar.cookiesForURL(BASE_URL);
  const name = Object.keys(cookies).find((key) => /authjs\.session-token/.test(key));
  return name ? `${name}=${cookies[name][0]}` : null;
}

export { page };
