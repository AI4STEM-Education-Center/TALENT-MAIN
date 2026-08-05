import { Trend, Rate, Counter } from "k6/metrics";

export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
export const REQUEST_HOST = __ENV.REQUEST_HOST || BASE_URL.replace(/^https?:\/\//, "").split("/")[0];
export const REQUEST_ORIGIN = `${BASE_URL.startsWith("https://") ? "https" : "http"}://${REQUEST_HOST}`;
export const FIXTURE_PATH = __ENV.FIXTURE || "./benchmark/fixture.json";
export const fixture = JSON.parse(open(FIXTURE_PATH));
export const timeScale = Math.max(0, Number(__ENV.TIME_SCALE || "0.05"));

export const workflowDuration = new Trend("workflow_duration", true);
export const quizSubmitDuration = new Trend("quiz_submit_duration", true);
export const businessErrors = new Rate("business_errors");
export const completedWorkflows = new Counter("completed_workflows");

const expectedRate = Math.max(1, Number(__ENV.RATE || "3"));
const burstUsers = Math.min(fixture.users.length, Math.max(1, Number(__ENV.BURST_USERS || "30")));

const profiles = {
  smoke: {
    student: { executor: "shared-iterations", exec: "studentOnly", vus: 1, iterations: 1, maxDuration: "2m" },
    quiz: { executor: "shared-iterations", exec: "quizOnly", vus: 1, iterations: 1, maxDuration: "5m" },
    teacher: { executor: "shared-iterations", exec: "teacherOnly", vus: 1, iterations: 1, maxDuration: "2m" },
    notification: { executor: "shared-iterations", exec: "notificationOnly", vus: 1, iterations: 1, maxDuration: "2m" },
  },
  load: {
    mixed: {
      executor: "constant-arrival-rate",
      exec: "mixedWorkflow",
      rate: expectedRate,
      timeUnit: "1s",
      duration: __ENV.DURATION || "15m",
      preAllocatedVUs: Math.max(10, expectedRate * 4),
      maxVUs: Math.max(50, expectedRate * 20),
    },
  },
  burst: {
    quiz: {
      executor: "per-vu-iterations",
      exec: "quizOnly",
      vus: burstUsers,
      iterations: 1,
      maxDuration: __ENV.DURATION || "10m",
    },
  },
  stress: {
    mixed: {
      executor: "ramping-arrival-rate",
      exec: "mixedWorkflow",
      startRate: 1,
      timeUnit: "1s",
      preAllocatedVUs: 20,
      maxVUs: Math.max(100, expectedRate * 40),
      stages: [
        { target: expectedRate, duration: "5m" },
        { target: expectedRate * 2, duration: "10m" },
        { target: expectedRate * 3, duration: "10m" },
        { target: expectedRate * 4, duration: "10m" },
        { target: 0, duration: "2m" },
      ],
    },
  },
  soak: {
    mixed: {
      executor: "constant-arrival-rate",
      exec: "mixedWorkflow",
      rate: expectedRate,
      timeUnit: "1s",
      duration: __ENV.DURATION || "4h",
      preAllocatedVUs: Math.max(10, expectedRate * 4),
      maxVUs: Math.max(50, expectedRate * 20),
    },
  },
  message: {
    message: {
      executor: "per-vu-iterations",
      exec: "messageFanout",
      vus: Math.max(1, Number(__ENV.MESSAGE_TEACHERS || "2")),
      iterations: Math.max(1, Number(__ENV.MESSAGE_ITERATIONS || "3")),
      maxDuration: __ENV.DURATION || "5m",
    },
  },
};

const profile = __ENV.PROFILE || "smoke";
if (!profiles[profile]) throw new Error(`Unknown PROFILE=${profile}`);

export const options = {
  scenarios: profiles[profile],
  discardResponseBodies: false,
  thresholds: {
    http_req_failed: ["rate<0.005"],
    http_req_duration: ["p(95)<750", "p(99)<1500"],
    "http_req_duration{name:quiz_start}": ["p(95)<1250"],
    "http_req_duration{name:quiz_submit}": ["p(95)<2000"],
    business_errors: ["rate<0.005"],
    dropped_iterations: ["count==0"],
  },
  summaryTrendStats: ["min", "med", "avg", "p(90)", "p(95)", "p(99)", "max"],
};
