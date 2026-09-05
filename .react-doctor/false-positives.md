# React Doctor — accepted findings and their evidence

Every entry below was verified against the source, not assumed. A future agent or
reviewer should re-check the stated **predicate** before trusting the suppression;
if the predicate no longer holds, remove the suppression instead of updating it.

Rules where *every* occurrence is rejected are turned off in `doctor.config.ts`.
Everything here is suppressed per-occurrence with an inline
`react-doctor-disable-next-line`, so the rule keeps guarding new code.

Baseline when this file was written: react-doctor 0.9.12, `--scope full`, 187
diagnostics, score 52.

---

## Security (3) — all sanitizer- or literal-protected

| Site | Predicate to re-check |
| --- | --- |
| `src/app/(auth)/reset-password/page.tsx` `AUTH_BACKDROP` | The value is still a Tailwind class list (`min-h-screen bg-linear-to-br …`) and never a credential. |
| `src/components/consent/ConsentForm.tsx` `dangerouslySetInnerHTML` | `bodyHtml` is still allowlist-sanitized by `sanitizeConsentHtml` on write (`api/admin/consent/forms/route.ts`) **and** at every read boundary (`api/consent/route.ts`, `teacher/consent-required/page.tsx`). `ConsentForm` still has only those two data sources. |
| `src/lib/prisma.ts` `$queryRawUnsafe` | The argument still comes only from the module-scope literal `sqlitePragmas` array. PRAGMA statements cannot be parameter-bound, so `$queryRaw` is not an option. |

## `no-loading-flag-reset-outside-finally` (3) — detector misfire

`admin/consent-requests/page.tsx`, `admin/consent/forms/page.tsx`,
`admin/resources/resources-client.tsx`.

The reset is **already inside a `finally` block** — `react-doctor why` prints
`} finally {` on the line directly above the one it flags. Two of the three are
additionally guarded by `if (!signal?.aborted)`, which is correct.

Predicate: the flagged `setLoading(false)` is lexically inside a `finally`.
**Upstream bug — report to <https://github.com/millionco/react-doctor/issues>.**
Remove these suppressions once the detector is fixed.

Two more sites acquired the same misfire while fixing real bugs, because the
canonical fix for a *different* rule is a guarded reset inside `finally`:
`(auth)/invite/[token]/invite-client.tsx` (guarded by request ownership) and
`teacher/.../students/page.tsx` (guarded by `signal.aborted`). Both are inside a
`finally`; the guard is what the detector cannot see.

The fourth original hit of this rule (`teacher/.../quizzes/quizzes-client.tsx`)
was a **real** defect and was fixed, not suppressed.

## `no-create-object-url-without-revoke` (3) — revoked, sometimes cross-module

`src/components/assistant/attachment-input.ts` at three sites.

- Line ~41 (`loadImage`) revokes in its own `finally`.
- The two `previewUrl` sites transfer ownership to the caller;
  `AssistantWidget.tsx` revokes on send, on clear, and on remove.

Predicate: those three `revokeObjectURL` calls in `AssistantWidget.tsx` still
exist. Known gap: an unmount with attachments still staged leaks those blobs
until the tab is closed — accepted as negligible, not detector-visible.

## `no-set-state-after-await-in-effect` (3) — AbortController-guarded

`admin/consent/forms/page.tsx`, `admin/consent/settings/page.tsx`,
`teacher/.../stats/request-consent-export-dialog.tsx`.

Predicate: each effect still constructs an `AbortController`, passes `signal` to
`fetch`, and calls `controller.abort()` in its cleanup, so an out-of-order
response cannot land.

Three further sites are suppressed for the equivalent reason after being fixed:
`teacher/.../materials/[materialId]/page-viewer.tsx`,
`teacher/.../students/page.tsx` and `components/feedback/my-feedback.tsx` now
guard **every** post-await write with `signal.aborted` — including the
`loading` reset, so an aborted request cannot clear the spinner owned by its
successor — but the rule only recognises an early-return ignore flag.

The other two original hits of this rule were **real** and were fixed.

## `no-locale-format-in-render` (5) — nothing renders during SSR

`admin/logs/page.tsx` ×2, `admin/resources/resource-chart.tsx` ×3.

Predicate: the formatted values still originate from a **client-side fetch or
hover state**, so the server-rendered HTML contains the empty/placeholder branch
and there is no server-vs-browser output to mismatch.

The other two hits (`invite-client.tsx`, `materials-list.tsx`) format
**server-provided props**, were genuine hydration risks, and were fixed.

## `no-array-index-as-key` (4) — stable or stateless lists

| Site | Predicate |
| --- | --- |
| `QuizPdfReview.tsx` warnings list | Still a read-only list of strings with no per-item state. |
| `QuizReviewResult.tsx` | Key still falls back to a content-composite string; list is read-only. |
| `StudentMistakesReview.tsx` | Key is content-composite; list is read-only. |
| `AssistantWidget.tsx` bubbles | `bubbles` is still **append-only** — never inserted into, removed from, or reordered. |

The other three hits were real (reorderable/deletable lists) and were fixed with
ingestion-time ids.

## `label-has-associated-control` (2) — correct Radix pattern

`admin/ai-config/page.tsx` Service Tier and Thinking Level.

A Radix `Select` renders no native form control, so `htmlFor` cannot bind to it.
These use `<label id="…">` + `<Select aria-labelledby="…">`, which is the correct
association. Predicate: the `id` and `aria-labelledby` values still match.

## `no-initialize-state` (1) — required framework pattern

`src/components/theme-toggle.tsx`. The `mounted` flag is the canonical
`next-themes` guard: `resolvedTheme` is only knowable client-side, so rendering
it during SSR is itself a hydration mismatch. Removing the flag reintroduces the
bug the rule elsewhere warns about.

## `prefer-html-dialog` (1) — not a modal

`src/components/assistant/AssistantWidget.tsx`. This is a docked, non-modal chat
panel that coexists with the page. `<dialog>` (even `show()`) changes stacking
and focus semantics; `role="dialog"` + `aria-label` already gives it a name and
a role. Predicate: the panel is still non-modal and does not trap focus.

## `no-unowned-async-error-clear` (1) — ownership is present

`(auth)/invite/[token]/invite-client.tsx`. Re-verifying an 81 number leaves two
lookups in flight, and the older one used to win. Each lookup now takes a
monotonic `lookupRequestId` and every post-await write — result, email-step
reset, and the loading flag — is gated on `isCurrent()`.

Predicate: `lookupRequestId` is still incremented per call and every write in
`handleVerify` is still behind `isCurrent()`. That gate *is* the request-ownership
check the rule asks for; it fires on the guarded line regardless.

## `no-impure-call-at-module-scope` (5) — one-shot CLI timestamps

`pressure/api-test.mjs` and `pressure/publish-k6-result.mjs` are executable Node
command-line programs, not imported application or render modules. Their
module-scope `Date` calls intentionally capture one run's start/end time and
generate a collision-resistant local run id. There is no SSR, hydration, cached
module state, or reusable import involved.

Predicate: both files remain executable CLI entry points and are not imported
by application code. If their result-building logic becomes reusable, move the
clock behind an injected function and remove these suppressions.

## `no-fetch-response-used-without-status-check` (1) — status precedes body read

`pressure/api-test.mjs` calculates whether `response.status` is accepted and
throws for a rejected status before calling `response.text()`. The scanner flags
the `fetch` assignment even though the required check is a few statements below.

Predicate: the accepted-status branch remains above the first body-consumption
call. Remove the suppression if response parsing moves ahead of that branch.
