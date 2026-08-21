// Composable user journeys.
//
// Journeys, not endpoints. The retired Python suite blasted a single endpoint
// with a shared login session, which measures the wrong thing twice over: it
// never produces the request MIX a real cohort produces, and one session means
// every write lands on one row. What actually breaks this app is a sequence —
// start a quiz (N RSA signatures + a transaction), think, submit (a transaction
// holding the single write lock, plus an ExamResult insert, plus a fresh queue
// DB handle) — arriving from many distinct identities at once.

import http from "k6/http";
import { sleep } from "k6";
import { BASE_URL, authHeaders } from "./config.js";
import { record } from "./metrics.js";

/** Per-question think time. Uniform RPS is not how a quiz is taken. */
function think(minS, maxS) {
  sleep(minS + Math.random() * (maxS - minS));
}

/**
 * Build a plausible answer for one question.
 *
 * VUs GUESS rather than answering correctly, for two reasons:
 *
 *  1. They cannot do otherwise. GET/POST /api/quiz deliberately strips the
 *     grading data — `omit: { answerNumeric, answerTolerance }` and options
 *     selected without `isCorrect` — so the answer key is genuinely not in the
 *     response. A harness that "knew" the answers would be reading from a
 *     channel real students do not have.
 *  2. A perfect attempt is the CHEAP path. Recommendation generation keys off
 *     missed questions (src/lib/recommendation.ts), so an all-correct cohort
 *     leaves the worker idle and understates the load the real system carries.
 */
function answerFor(question) {
  const options = question.options || [];
  if (question.answerMode === "NUMERIC") {
    return { questionId: question.id, numericValue: Math.round(Math.random() * 100) / 2 };
  }
  if (question.answerMode === "MULTI_SELECT") {
    // One pass rather than filter().map(): this runs per question per iteration,
    // and allocating a throwaway intermediate array inside the load generator's
    // hot path is cost that shows up as generator overhead, not app latency.
    const picked = [];
    for (const option of options) {
      if (Math.random() < 0.5) picked.push(option.id);
    }
    // Never submit an empty MULTI_SELECT: scoreQuiz treats it as unanswered,
    // which is a valid case but a different one from "answered wrongly".
    if (picked.length === 0 && options.length > 0) picked.push(options[0].id);
    return { questionId: question.id, selectedOptionIds: picked };
  }
  if (options.length === 0) return { questionId: question.id };
  return { questionId: question.id, selectedOptionId: options[Math.floor(Math.random() * options.length)].id };
}

/**
 * Fetch the signed media a real quiz page would load.
 *
 * The browser requests every figure and image answer choice from CloudFront as
 * soon as the quiz renders. Skipping that would hide the second half of the
 * CloudFront change: the app pays RSA signing cost per URL, and the CDN then
 * has to serve them. Only a bounded sample is fetched — the point is to keep
 * the edge in the picture, not to benchmark CloudFront's own throughput.
 */
export function fetchQuizMedia(questions, limit) {
  const urls = [];
  for (const q of questions) {
    if (q.figureUrl) urls.push(q.figureUrl);
    for (const o of q.options || []) {
      if (o.imageUrl) urls.push(o.imageUrl);
    }
    if (urls.length >= limit) break;
  }
  if (urls.length === 0) return 0;
  const batch = urls.slice(0, limit).map((u) => ({ method: "GET", url: u }));
  const responses = http.batch(batch);
  for (const res of responses) {
    // 403 from CloudFront means the signature was rejected — a real
    // misconfiguration (wrong key group / clock skew), not a designed refusal,
    // so it must not be swallowed as one.
    record("quiz_media", res, [200, 304]);
  }
  return batch.length;
}

/**
 * The headline student journey: open the class, start a quiz, answer with think
 * time, submit, read results.
 *
 * `opts.fetchMedia` pulls the signed media too. `opts.thinkPerQuestion` is the
 * per-question pause range in seconds — set it to [0, 0] for a submit clump.
 */
export function studentQuizJourney(identity, opts) {
  const options = opts || {};
  const headers = authHeaders(identity);
  const thinkRange = options.thinkPerQuestion || [2, 6];

  const classesRes = http.get(`${BASE_URL}/api/classes`, { headers, tags: { step: "student_dashboard" } });
  if (!record("student_dashboard", classesRes, [200])) return null;

  let classes;
  try {
    classes = classesRes.json();
  } catch (e) {
    record("student_dashboard", classesRes, []);
    return null;
  }
  if (!Array.isArray(classes) || classes.length === 0) return null;
  const klass = classes[Math.floor(Math.random() * classes.length)];

  const quizzesRes = http.get(`${BASE_URL}/api/classes/${klass.id}/quizzes`, {
    headers,
    tags: { step: "class_quizzes" },
  });
  if (!record("class_quizzes", quizzesRes, [200])) return null;

  const classQuizzes = (quizzesRes.json() || []).filter((cq) => cq.published);
  if (classQuizzes.length === 0) return null;
  const target = classQuizzes[Math.floor(Math.random() * classQuizzes.length)];

  const startRes = http.post(
    `${BASE_URL}/api/quiz`,
    JSON.stringify({ classId: klass.id, quizId: target.quizId }),
    { headers, tags: { step: "student_quiz_start" } }
  );
  // 403 is designed here (attempt cap exhausted, quiz not open yet / closed) and
  // is the expected steady state late in a soak — it must not fail the run.
  if (!record("student_quiz_start", startRes, [200])) return null;

  const started = startRes.json();
  const questions = started.questions || [];
  if (questions.length === 0) return null;

  if (options.fetchMedia) fetchQuizMedia(questions, options.mediaLimit || 6);

  const answers = [];
  for (const question of questions) {
    answers.push(answerFor(question));
    if (thinkRange[1] > 0) think(thinkRange[0], thinkRange[1]);
  }

  const submitRes = http.patch(
    `${BASE_URL}/api/quiz`,
    JSON.stringify({ attemptId: started.attemptId, answers }),
    { headers, tags: { step: "student_quiz_submit" } }
  );
  if (!record("student_quiz_submit", submitRes, [200])) return null;

  // The results page the student lands on immediately after submitting. It may
  // legitimately 404 for a moment while the worker is still generating the AI
  // sections, which is why 404 is accepted alongside 200.
  const resultsRes = http.get(`${BASE_URL}/api/student/attempts/${started.attemptId}/results`, {
    headers,
    tags: { step: "student_results" },
  });
  record("student_results", resultsRes, [200, 404]);

  return started.attemptId;
}

/** Teacher monitoring a live quiz: class list, assigned quizzes, then stats. */
export function teacherMonitorJourney(identity) {
  const headers = authHeaders(identity);

  const classesRes = http.get(`${BASE_URL}/api/classes`, { headers, tags: { step: "teacher_dashboard" } });
  if (!record("teacher_dashboard", classesRes, [200])) return;

  const classes = classesRes.json();
  if (!Array.isArray(classes) || classes.length === 0) return;
  const klass = classes[Math.floor(Math.random() * classes.length)];

  const quizzesRes = http.get(`${BASE_URL}/api/classes/${klass.id}/quizzes`, {
    headers,
    tags: { step: "class_quizzes" },
  });
  if (!record("class_quizzes", quizzesRes, [200])) return;

  const classQuizzes = quizzesRes.json() || [];
  if (classQuizzes.length === 0) return;
  const target = classQuizzes[Math.floor(Math.random() * classQuizzes.length)];

  // The expensive one: aggregates every attempt and answer row for the quiz
  // in-process (src/lib/quiz-stats-server.ts), so its cost grows with the
  // cohort that has already submitted — it gets slower as an exam-day run goes on.
  const statsRes = http.get(`${BASE_URL}/api/classes/${klass.id}/quizzes/${target.quizId}/stats`, {
    headers,
    tags: { step: "teacher_quiz_stats" },
  });
  record("teacher_quiz_stats", statsRes, [200]);

  think(3, 8);

  const notifRes = http.get(`${BASE_URL}/api/notifications`, {
    headers,
    tags: { step: "notifications" },
  });
  record("notifications", notifRes, [200]);
}

/**
 * Admin sitting on the dashboard with the System Resources tab open.
 *
 * This is a first-class load source, not a curiosity. `GET /api/admin/resources`
 * calls readSpool(), which is SYNCHRONOUS: readFileSync plus a full line-parse
 * of every node's NDJSON file (src/lib/resource-spool.ts), on the main thread.
 * At four nodes x one sample/minute x seven days of retention that is roughly
 * 40k lines parsed per request, and every millisecond of it is a millisecond no
 * other request can be served — including quiz submissions.
 */
export function adminObservabilityJourney(identity, range) {
  const headers = authHeaders(identity);

  const resourcesRes = http.get(`${BASE_URL}/api/admin/resources?range=${range || "24h"}`, {
    headers,
    tags: { step: "admin_resources" },
  });
  record("admin_resources", resourcesRes, [200]);

  const statsRes = http.get(`${BASE_URL}/api/admin/stats`, { headers, tags: { step: "admin_stats" } });
  record("admin_stats", statsRes, [200]);

  const logsRes = http.get(`${BASE_URL}/api/admin/logs?limit=100`, {
    headers,
    tags: { step: "admin_logs" },
  });
  record("admin_logs", logsRes, [200]);
}

/** Unauthenticated landing page — also what the container health check hits. */
export function publicLanding() {
  const res = http.get(`${BASE_URL}/`, { tags: { step: "static_page" } });
  record("static_page", res, [200]);
}

export { think };
