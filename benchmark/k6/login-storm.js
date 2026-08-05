import { sleep } from "k6";
import { fixture } from "./lib/config.js";
import { realLogin } from "./lib/session.js";

export const options = {
  scenarios: {
    login: {
      executor: "per-vu-iterations",
      vus: Math.min(fixture.users.length, Math.max(1, Number(__ENV.LOGIN_USERS || "10"))),
      iterations: 1,
      maxDuration: "5m",
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
    "http_req_duration{name:auth_login}": ["p(95)<1500"],
  },
};

export default function () {
  if (Number(__ENV.LOGIN_STAGGER_SECONDS || "0") > 0) sleep((__VU - 1) * Number(__ENV.LOGIN_STAGGER_SECONDS));
  realLogin(fixture.users[(__VU - 1) % fixture.users.length]);
}
