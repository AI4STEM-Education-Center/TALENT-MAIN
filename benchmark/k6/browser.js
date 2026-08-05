import { browser } from "k6/browser";
import { check } from "k6";
import { BASE_URL, fixture } from "./lib/config.js";

export const options = {
  scenarios: {
    browser: {
      executor: "shared-iterations",
      vus: Number(__ENV.BROWSER_VUS || "2"),
      iterations: Number(__ENV.BROWSER_ITERATIONS || "6"),
      options: { browser: { type: "chromium" } },
    },
  },
  thresholds: {
    browser_web_vital_lcp: ["p(75)<2500"],
    browser_web_vital_inp: ["p(75)<200"],
    browser_web_vital_cls: ["p(75)<0.1"],
    checks: ["rate>0.99"],
  },
};

export default async function () {
  const page = await browser.newPage();
  const user = fixture.users[(__VU - 1) % fixture.users.length];
  const secure = BASE_URL.startsWith("https://");
  await page.context().addCookies([{
    name: secure ? "__Secure-authjs.session-token" : "authjs.session-token",
    value: secure ? user.session.secure : user.session.local,
    url: BASE_URL,
    httpOnly: true,
    secure,
    sameSite: "Lax",
  }]);
  try {
    await page.goto(`${BASE_URL}/student`, { waitUntil: "networkidle" });
    check(page, { "student dashboard rendered": (value) => value.url().includes("/student") });
    await page.goto(`${BASE_URL}/student/classes/${user.classId}`, { waitUntil: "networkidle" });
    check(page, { "class page rendered": (value) => value.url().includes(user.classId) });
  } finally {
    await page.close();
  }
}
