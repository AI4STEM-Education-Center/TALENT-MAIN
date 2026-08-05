import http from "k6/http";
import { check } from "k6";
import { BASE_URL, REQUEST_HOST, REQUEST_ORIGIN, businessErrors } from "./config.js";

export function useSession(principal) {
  const secure = BASE_URL.startsWith("https://");
  const name = secure ? "__Secure-authjs.session-token" : "authjs.session-token";
  const value = secure ? principal.session.secure : principal.session.local;
  http.cookieJar().set(BASE_URL, name, value, {
    path: "/",
    secure,
    http_only: true,
    same_site: "Lax",
  });
}

export function realLogin(principal) {
  const csrf = http.get(`${BASE_URL}/api/auth/csrf`, {
    headers: { Host: REQUEST_HOST },
    tags: { name: "auth_csrf" },
  });
  const token = csrf.status === 200 ? csrf.json("csrfToken") : null;
  if (!token) {
    businessErrors.add(true);
    return false;
  }
  const response = http.post(
    `${BASE_URL}/api/auth/callback/credentials`,
    { csrfToken: token, identifier: principal.username, password: principal.password, redirect: "false" },
    {
      redirects: 0,
      headers: { Host: REQUEST_HOST, Origin: REQUEST_ORIGIN },
      tags: { name: "auth_login" },
    }
  );
  const ok = check(response, { "credential login accepted": (res) => [200, 302, 303].includes(res.status) });
  businessErrors.add(!ok);
  return ok;
}
