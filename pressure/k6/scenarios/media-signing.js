// Media signing cost — the pressure point the CloudFront change introduced.
//
// THE HYPOTHESIS. Commit af6fe35 ("serve private media through CloudFront")
// changed src/lib/storage.ts signObjectReadUrl from an S3 presign to a
// CLOUDFRONT signed URL. Those are not equivalent in cost:
//
//   S3 presign        -> HMAC-SHA256 over a canonical request. Microseconds.
//   CloudFront signed  -> RSA-SHA1 signature with a 2048-bit private key.
//                         Roughly a millisecond, and it is CPU, on the event loop.
//
// POST /api/quiz calls attachFigureUrls() then attachOptionImageUrls()
// (src/lib/question-figures.ts). Both map over the whole question set with
// Promise.all, one signature per question figure AND one per image answer
// choice. A 20-question quiz where each question has a figure and four image
// options is 20 + 80 = 100 RSA signatures for ONE quiz start. Promise.all does
// not make that parallel — it is 100 sequential CPU operations on a single
// thread, and every one of them blocks every other request in flight.
//
// So the cost scales with (figures + image options), NOT with question count,
// and it is invisible in any dataset whose questions have no media. That is
// exactly why this needs its own scenario and its own seeded fixture.
//
// HOW TO READ IT. Run twice against the same commit and the same dataset, once
// with CLOUDFRONT_* set and once with them cleared (the documented rollback
// switch in .env.example). The delta in student_quiz_start IS the signing cost.
// Run it explicitly through pressure/run.sh when signing cost is the question.

import { requireTier, identityFor, BASE_URL, authHeaders, CLOUDFRONT_EXPECTED, RUN_LABEL, SLO, MEDIA_TARGET } from "../lib/config.js";
import { thresholds, record, TREND_STATS } from "../lib/metrics.js";
import { fetchQuizMedia } from "../lib/journeys.js";
import http from "k6/http";
import { check } from "k6";

requireTier("media-signing", ["ec2-clone"]);

const VUS = Number(__ENV.PRESSURE_SIGNING_VUS || 8);
const STEPS = ["student_quiz_start", "quiz_media"];

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    signing: { executor: "constant-vus", exec: "startMediaQuiz", vus: VUS, duration: __ENV.PRESSURE_SIGNING_DURATION || "2m" },
  },
  thresholds: thresholds(STEPS, SLO),
};

/**
 * Repeatedly start (and never submit) the media-heaviest quiz available.
 *
 * Not submitting is intentional and safe: POST /api/quiz RESUMES an existing
 * unfinished attempt rather than minting a new one, so this loop re-signs every
 * URL on every iteration without consuming attempt-cap slots. That isolates
 * signing cost from write-lock cost, which is what exam-day measures.
 */
export function startMediaQuiz() {
  const identity = identityFor("students", __VU);
  const headers = authHeaders(identity);

  const target = MEDIA_TARGET;
  if (!target.classId || !target.quizId) {
    console.error("[media-signing] PRESSURE_MEDIA_TARGET must be {\"classId\":…,\"quizId\":…} — the runner sets this from the seed manifest");
    return;
  }

  const res = http.post(`${BASE_URL}/api/quiz`, JSON.stringify(target), {
    headers,
    tags: { step: "student_quiz_start" },
  });
  if (!record("student_quiz_start", res, [200])) return;

  const body = res.json();
  const questions = body.questions || [];

  // Count what was actually signed, so the report can state cost-per-signature
  // instead of just a latency number.
  let signatures = 0;
  let cloudFrontUrls = 0;
  for (const q of questions) {
    if (q.figureUrl) {
      signatures++;
      if (q.figureUrl.indexOf("cloudfront") !== -1 || q.figureUrl.indexOf("Key-Pair-Id") !== -1) cloudFrontUrls++;
    }
    for (const o of q.options || []) {
      if (o.imageUrl) {
        signatures++;
        if (o.imageUrl.indexOf("Key-Pair-Id") !== -1) cloudFrontUrls++;
      }
    }
  }

  // Fail loudly on a dataset with no media: the scenario would otherwise report
  // a healthy p95 that measures nothing at all.
  check(signatures, {
    "quiz has signed media to measure": (n) => n > 0,
  });
  if (signatures === 0) {
    console.error("[media-signing] target quiz has NO figures or image options — this run measures nothing. Reseed with --media-heavy.");
    return;
  }

  // Confirm the delivery path matches what the run claims to be measuring. A
  // run labelled "with CloudFront" that is actually presigning from S3 produces
  // a real-looking number for the wrong configuration.
  check(cloudFrontUrls, {
    "signed URLs match the expected delivery path": (n) => (CLOUDFRONT_EXPECTED ? n > 0 : n === 0),
  });

  fetchQuizMedia(questions, 8);
}

export function handleSummary(data) {
  const path = CLOUDFRONT_EXPECTED ? "CloudFront (RSA-SHA1 per URL)" : "S3 presign (HMAC per URL)";
  return {
    stdout: `\nmedia-signing complete: delivery=${path} label=${RUN_LABEL}\n`,
  };
}
