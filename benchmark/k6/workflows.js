import http from "k6/http";
import exec from "k6/execution";
import { check, sleep } from "k6";
import {
  BASE_URL,
  REQUEST_HOST,
  REQUEST_ORIGIN,
  fixture,
  options,
  timeScale,
  workflowDuration,
  quizSubmitDuration,
  businessErrors,
  completedWorkflows,
} from "./lib/config.js";
import { useSession } from "./lib/session.js";

export { options };

function studentForVu() {
  return fixture.users[(__VU - 1) % fixture.users.length];
}

function request(method, path, body, name, expected = [200]) {
  const params = {
    headers: { Host: REQUEST_HOST, Origin: REQUEST_ORIGIN, "Content-Type": "application/json" },
    tags: { name },
  };
  const response = method === "GET"
    ? http.get(`${BASE_URL}${path}`, params)
    : http.request(method, `${BASE_URL}${path}`, body === null ? null : JSON.stringify(body), params);
  const ok = check(response, { [`${name} status`]: (res) => expected.includes(res.status) });
  businessErrors.add(!ok);
  return response;
}

function pause(seconds) {
  if (timeScale > 0) sleep(seconds * timeScale);
}

function browseStudent(user) {
  request("GET", "/student", null, "student_dashboard");
  pause(4);
  request("GET", "/api/classes", null, "student_classes_api");
  request("GET", `/student/classes/${user.classId}`, null, "student_class_page");
  pause(8);
  request("GET", "/api/notifications?take=10", null, "notifications_list");
}

function browseTeacher() {
  useSession(fixture.teacher);
  request("GET", "/teacher", null, "teacher_dashboard");
  request("GET", "/api/classes", null, "teacher_classes_api");
  const classId = fixture.teacher.classIds[exec.scenario.iterationInTest % fixture.teacher.classIds.length];
  request("GET", `/teacher/classes/${classId}/stats`, null, "teacher_class_stats_page");
  request("GET", `/api/classes/${classId}/students`, null, "teacher_students_api");
}

function answerFor(question, incorrect) {
  if (question.mode === "NUMERIC") {
    return { questionId: question.id, numericValue: incorrect ? question.numericAnswer + 10 : question.numericAnswer };
  }
  if (question.mode === "MULTI_SELECT") {
    return { questionId: question.id, selectedOptionIds: incorrect ? [question.wrongOptionId] : question.correctOptionIds };
  }
  return {
    questionId: question.id,
    selectedOptionId: incorrect ? question.wrongOptionId : question.correctOptionIds[0],
  };
}

function takeQuiz(user) {
  const start = request(
    "POST",
    "/api/quiz",
    { classId: user.classId, quizId: user.quizId },
    "quiz_start"
  );
  if (start.status !== 200) return;
  const attemptId = start.json("attemptId");
  if (!attemptId) {
    businessErrors.add(true);
    return;
  }
  pause(Number(__ENV.QUIZ_THINK_SECONDS || "120"));
  const answers = user.questions.map((question, index) => answerFor(question, (index + __VU) % 5 === 0));
  const submittedAt = Date.now();
  const submit = request("PATCH", "/api/quiz", { attemptId, answers }, "quiz_submit");
  quizSubmitDuration.add(Date.now() - submittedAt);
  if (submit.status === 200) {
    pause(2);
    request("GET", `/api/student/attempts/${attemptId}/results`, null, "quiz_results");
  }
}

export function mixedWorkflow() {
  const startedAt = Date.now();
  const user = studentForVu();
  useSession(user);
  const bucket = exec.scenario.iterationInTest % 100;
  if (bucket < 40) browseStudent(user);
  else if (bucket < 70) takeQuiz(user);
  else if (bucket < 85) browseTeacher();
  else {
    request("GET", "/api/notifications?take=50", null, "notifications_list");
    request("POST", "/api/notifications/read", { all: true }, "notifications_read");
  }
  workflowDuration.add(Date.now() - startedAt);
  completedWorkflows.add(1);
}

export function quizOnly() {
  const user = studentForVu();
  useSession(user);
  takeQuiz(user);
  completedWorkflows.add(1);
}

export function studentOnly() {
  const user = studentForVu();
  useSession(user);
  browseStudent(user);
  completedWorkflows.add(1);
}

export function teacherOnly() {
  browseTeacher();
  completedWorkflows.add(1);
}

export function notificationOnly() {
  const user = studentForVu();
  useSession(user);
  request("GET", "/api/notifications?take=50", null, "notifications_list");
  request("POST", "/api/notifications/read", { all: true }, "notifications_read");
  completedWorkflows.add(1);
}

export function messageFanout() {
  useSession(fixture.teacher);
  const classId = fixture.teacher.classIds[exec.scenario.iterationInTest % fixture.teacher.classIds.length];
  request(
    "POST",
    `/api/classes/${classId}/messages`,
    {
      subject: `Benchmark announcement ${Date.now()}`,
      body: "GPT-5.6 automated message fan-out pressure test.",
    },
    "message_fanout",
    [201]
  );
  completedWorkflows.add(1);
}
