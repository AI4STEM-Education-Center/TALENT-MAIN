# Wrong-answer coach

Students can choose **Chat with assistant** on a missed question in their exam results. A dialog keeps the original prompt and their response visible beside a conversation with the existing student assistant. The assistant first asks how they approached the question, then gives advice or offers a course material, a simulation guide, or an existing published alternative question. It does not generate new practice questions.

The coach shares the assistant's provider, moderation, reply audit, hourly turn budget, transcript retention and administrator transcript access. Teachers gain no transcript access. Consent and research export follow the existing assistant policies. Turning off the student assistant also turns off the coach.

## Access and answer keys

All three routes resolve the caller from the authenticated student session and verify ownership of the archived ExamResult and a strictly incorrect question verdict. Other students, teachers, missing attempts and correctly answered questions receive 404. Question numbers refer to the durable snapshot, not the current quiz order.

While another graded submission remains possible, the dialog and model receive the original prompt and only the student's submitted response; other choices, correct numeric values, tolerances and teacher explanations are withheld. Once the attempt is final, the coach may show the full review. Conversations are separated by answer-key policy so a final-review transcript cannot be replayed after a teacher allows more retakes. Existing conversations without a policy key remain available through administrator retention and export, but are not resumed in the dialog.

Card tools accept only bounded references and text. The server revalidates every material number, simulation id and alternative-question match before streaming a card and whenever a saved card is reopened. Retired versions and simulations that the student can no longer access disappear. Each turn can show at most two cards. The model never sees a practice question's answer key or solution.

## Routes and storage

- `GET /api/assistant/coach?attemptId=…&questionNumber=…` returns the question, static opening and eligible transcript.
- `POST /api/assistant/coach/chat` accepts a message and that question's coordinates, with a 32 KiB body cap. It uses the shared `chat-handler.ts` and NDJSON protocol; it accepts no attachments or client-supplied history.
- `POST /api/assistant/coach/practice` accepts one alternative-question response, with an 8 KiB cap, and returns only `{ correct }`. It does not create QuizAttempt, QuizPracticeAttempt or progress rows. Alongside the account budget, one verdict per student and published question per day limits choice enumeration across source attempts and classes. These limits share the deployment's process-local limiter and reset on restart; multiple app replicas require a shared limiter.

Coach transcripts are isolated from the widget's history and resume API. A write-first SQLite transaction atomically reserves one active conversation per student, attempt, question and answer-key policy using the indexed, nullable `AssistantConversation.coachActiveKey`. Expired slots are released without deleting their transcripts. `coachResultId` and `coachQuestionNumber` retain the durable coordinates, and `AssistantMessage.actions` stores validated card references. Cold archives and research exports preserve the references. The nullable columns and default-empty actions column can be added to an existing database with `prisma db push`.

## Alternative-retake integration

When integrating the separate alternative-retake branch, apply its graded-attempt filter to the shared `retakeStillPossible` helper and always withhold keys for alternative-version results. Alternative QuizAttempt rows must not consume the graded allowance. Their snapshots use source question ids, so ownership, wrong-question checks and simulation mapping continue to work; question numbers remain positions in the possibly reduced alternative snapshot. Avoid offering that result's own published question again as a fresh practice question.

## Validation

Route tests cover ownership, role restrictions, answer-key withholding, policy changes, concurrent conversation creation, retention, card revalidation, action-only replies, guardrails, bounded bodies and practice grading limits. Component tests cover opening and closing the dialog, focus restoration, streamed cards, interrupted streams and inline practice. Model calls are scripted in tests; model-written advice and card text still depend on the configured model following the assistant's academic-honesty instructions.
