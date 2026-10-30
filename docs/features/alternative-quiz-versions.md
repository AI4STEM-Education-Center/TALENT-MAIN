# Alternative quiz practice

Teachers start from the **Generate new version** button in the quiz editor's **Alternative versions** section and choose what the new version is for: an **alternate version of this exam** or a **standalone exam**. Optional per-question learning objectives and restrictions refine the source-preserving defaults. Each round generates four drafts: two that change numbers and choices, and two that also change the context.

A draft is shown only after structural validation and an independent model solve agree. When a draft is rejected, the worker regenerates it automatically, feeding the rejection reasons back, up to four generate-and-verify attempts per draft. Only if every attempt fails does the draft surface as failed, with a **Regenerate** button. Drafts a teacher edited by hand are re-verified but never silently replaced.

Each change mode shows the original next to its two newest drafts, question by question, with solutions and the independent check one click away. Actions sit directly on each draft: **Approve as alternate** publishes it for practice on this exam, and **Save as standalone exam** creates a separate, editable exam in the same scope and topic. Both are always offered, and the button matching the teacher's starting choice is highlighted. **Approve both as alternates** and **Save both as standalone exams** handle a pair at once. Teachers can write feedback on any draft and choose **Regenerate with feedback**: the draft is discarded and a new one is generated against it and verified again. **Discard** drops a draft, and **Edit** hand-edits the answer key before re-verification. For alternates (and for any mode where an alternate was approved), **Generate two more** adds two drafts of that mode to the same round. Saved alternates and standalone exams are listed under **Saved versions**, where alternates can be retired. Published versions are immutable.

Students use **Practice alternatives** on a class quiz, or **Practice another version** after a graded attempt. New attempts prefer unseen published versions; once exhausted, they avoid the immediately previous version when another is available. Reloading a started attempt resumes exactly the same questions and choice order.

## Alternative runs are retakes

Everything a student does on an alternative version is recorded as a **retake of the original quiz** in the same pipeline ordinary attempts use:

- **Start** creates an unfinished `QuizAttempt` for the student/class/quiz with `practiceVersionId` and `practiceVersionName` set (and `excludedQuestionIds`, below). The immutable question payload lives in `QuizPracticeAttempt`, linked by `quizAttemptId`. Unfinished alternative attempts appear in the administrator's unfinished-quizzes list, labelled with the version.
- **Submit** completes the attempt with its score, writes `QuizAnswer` rows, and creates the same durable `ExamResult` snapshot and background job as an ordinary attempt (`enqueueExamResult`). Alternative questions have no `Question` row, so each answer is filed under the variant's **source question** (the alternative's own choice ids go in `selectedOptionIds`; `selectedOptionId` stays empty). The review snapshot's question id is also the source question, so a missed alternative question still maps to that question's simulation and to misconception labelling.
- **Results** use the same view as an ordinary quiz: AI summary, missed-question review, up to three holistic material recommendations, and recommended simulations, streamed from `/api/student/attempts/{quizAttemptId}/results`. The result appears in Exam History (labelled with the version), on the practice landing page, and in the teacher's per-student attempt list and attempt detail. Research-consent gating is unchanged: material and simulation recommendations are available to every student; teacher-only misconception diagnostics are produced only for students who agreed to research. Teachers see alternative retakes of all students identically, so nothing reveals who participates.
- The ordinary `/api/quiz` endpoint ignores alternative attempts when starting or resuming and refuses to grade one (409), so the two cannot be mixed up.

### Grading semantics (the safe defaults)

An alternative retake is **recorded but does not count toward the graded record**. This is deliberate: a version is not psychometrically equivalent to the exam, and a retake that excludes questions covers only part of it.

| Aspect | Alternative retake |
| --- | --- |
| Attempt history / exam history / results page | Recorded, labelled "Alternative: *version*" |
| Best score, `QuizProgress`, manual grade, grades CSV export | **Not counted** |
| Attempt cap (`maxAttempts`) | **Not consumed**; practice stays available when the graded allowance is used up |
| Availability window (`availableFrom/Until`) and enrollment | Enforced at start, as before (a started run may still be submitted after the window closes) |
| Class/quiz stats (mean, median, pass rate, distribution, per-question rates, average attempts) | **Excluded**; teachers see a separate "alternative-version retakes" count, per student and per quiz |
| Student attempt list in teacher views | Included, labelled |
| Student assistant | Listed by search (with `alternativeVersion`); excluded from performance averages; answer key always withheld |
| Research export | `quiz_attempt`, `quiz_answer` and `exam_result` rows carry `practiceVersionId`/`practiceVersionName`/`excludedQuestionIds`/`excludedCount` |

All grade-affecting queries share one filter, `GRADED_ATTEMPTS` in `src/lib/alternative-retake.ts`. If the product decision changes (for example counting full-coverage alternative runs toward the best score), that constant plus the progress update in the practice submit route are the places to change.

### Excluding questions answered correctly

Before starting, a student who has a completed attempt on the quiz can tick **Skip the questions I answered correctly last time**. It defaults to on whenever there is something to skip and something left to ask.

- "Correct" means each source question's result in the **most recent completed attempt that asked it** (ordinary or alternative). That equals "your last attempt" when the last attempt covered the whole quiz, and stays well defined after an earlier run left some questions out.
- The retake then contains only the alternative versions of the other questions; the excluded source ids are stored on the attempt.
- **Everything already correct:** nothing would remain, so the full version is asked instead and the page says so (`exclusionIgnored`). The checkbox is hidden when nothing was correct or when a run is in progress (resuming never changes the question set).
- **Scoring:** the score and the `ExamResult` (`correctCount`/`totalCount`) cover only the questions asked, so a 1-of-1 retake reads 100%. That is why such runs are labelled and never mixed into graded statistics. The results page and teacher attempt detail state how many previously-correct questions were left out.
- Because the excluded questions are never asked, they are not marked wrong anywhere: the student's per-question history still shows the earlier correct result.

## Setup

- Deploy the web application and worker together. The additive Prisma schema creates `QuizPracticeVersion` and `QuizPracticeAttempt`, plus the round/purpose/feedback/standalone columns on `QuizPracticeVersion`, `QuizPracticeAttempt.quizAttemptId`, `QuizAttempt.practiceVersionId/practiceVersionName/excludedQuestionIds` and `ExamResult.practiceVersionName/excludedCount`. Existing records need no backfill (null/empty means an ordinary attempt); versions from before rounds existed appear only under **Saved versions**.
- Assign a model/provider to **Alternative Quiz Versions** (`quiz_variants`) in the administrator AI Config screen.
- Run the existing `npm run worker` process. The new `quiz-variants` Honker queue is consumed alongside other AI jobs.
- Unassigned providers and queue/model failures appear as retryable failures in the teacher panel. A worker sweep marks jobs stranded for 30 minutes as failed. Conditional writes fence stale generation completions after retries.

## Scope and guarantees

The first release supports quizzes of 1–40 text-only single-select and numeric questions. It explicitly rejects image-dependent and multi-select source quizzes. A new round can start only when nothing is generating for the quiz; **Generate two more** may run alongside the round, with at most eight drafts generating per quiz. Every draft is queued independently, and failed jobs remain retryable. Publication makes a version available through that quiz's published class assignments; enrollment and availability windows are enforced at practice start. Graded attempt caps do not apply to alternative retakes. Previously started work may be submitted after the availability window closes, provided the student is still enrolled.

Each version stores source content and the default or teacher-supplied objectives. Each practice attempt stores its own complete immutable question/answer-key payload, even if the version is subsequently retired or the source content is edited/deleted. Student responses and scores live in a separate archive, with a unique active-attempt key and conditional single-use submission; the matching `QuizAttempt`/`ExamResult` is the retake record. A source question deleted after publication simply has no `QuizAnswer` row for that retake; the `ExamResult` snapshot still holds everything. Student start/history responses use explicit field allowlists and never expose answer keys, solutions, objectives, or AI validation messages. Archived attempts survive quiz deletion (the `QuizAttempt` keeps its history like any attempt, the `ExamResult` is relation-free), although the practice landing page requires a currently accessible assignment. Runs started before retakes were recorded are filed as a retake when they are submitted.

The model sees assessment content, not student records. Independent verification receives neither generated answers nor generated solutions. Structural checks require source coverage, unchanged answer modes/units/tolerances, unique IDs, valid choices, finite numeric answers, and exactly one correct single-select choice. These checks and model agreement do **not** establish psychometric equivalence or mathematically prove arbitrary solutions. Teacher review remains mandatory. Fully changed premises, diagrams, multi-select, automatic intent inference, per-class practice limits, and graded variants are outside this initial release.

## Validation

Tests exercise retake recording, exclusion (including all-correct and chained retakes), isolation from grades/caps/stats, end-to-end result generation with a mocked provider, source coverage, malformed answer keys, independent-check disagreement, missing provider, revalidation, stale-worker fencing, ownership, enrollment, availability, immutable resume, concurrent starts, unseen-version selection, malformed/duplicate answers, single-use submission, retirement, archival retention, and separation from graded progress. The player regression test verifies practice-specific start/submit/retry behavior. Model calls are mocked in automated tests; administrators should pilot their configured model on representative course questions before broad publication.
