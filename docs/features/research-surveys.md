# Research surveys and study periods

Admins manage the study's surveys at **Admin → Surveys** (`/admin/surveys`).
Each form has a kind (pre-survey or post-survey) and an audience (students or
teachers). Post-surveys also have a **study period** (1 or 2), because each
period of platform use ends with its own post-survey.

## Which forms are live

- One pre-survey per role can be enabled at a time.
- One post-survey per role **and period** can be enabled at a time. If you
  enable the Period 2 post-survey, the Period 1 post-survey stays enabled, so
  emailed Period 1 links keep working.
- You can set the period when you create a form (upload or template) and
  change it later in the editor.

## Pre-survey (in app)

After the IRB consent decision, the enabled pre-survey appears in the app. It
is mandatory for anyone whose latest decision is "agree" and optional (with
"Maybe later" / "No thanks") for everyone else.

## Post-surveys

There are two ways to deliver a post-survey:

1. **Emailed links** (Admin → Post-survey email). The composer lets you pick
   which period's form the links open. By default it uses the lowest period
   that has an enabled form. The preview shows which form each role's links
   open. People who already answered that form, by link or in the app, are
   skipped.
2. **Prompt in app.** On an enabled post-survey, choose **Prompt in app**. A
   participant then gets a mandatory pop-up before they use the platform. The
   pop-up says "Before you continue, please complete the Period N
   post-survey". It goes to people who meet all of these:
   - their decision was "agree" at the moment the prompt was first turned on.
     This is their latest consent record from before that moment, on any
     consent form version;
   - their latest decision on the active consent form is still "agree";
   - they took a pre-survey before the prompt was first turned on;
   - they haven't answered that form yet. A response through an emailed
     link counts.

   This means someone who joins the study after the prompt starts never gets
   the earlier period's post-survey. That includes a student who declined
   earlier and agrees now, even if they took the optional pre-survey while
   they were declining. It also includes someone who agreed, then declined
   before the prompt started, then agreed again. Publishing a new consent
   version between periods doesn't exclude anyone: once they agree to the
   new version, their earlier "agree" still counts.

   Once a post-survey has responses, emailed links or an in-app prompt, its
   study period is locked. For the next period, create a new form. If you
   turn the prompt off and on again, the original
   start time is kept. If more than one period is prompting, people see the
   lowest unanswered period first. The admin list shows how many eligible
   people have completed it.

The in-app pre-survey always comes first. A post-survey pop-up only appears
when no pre-survey is owed.

If the survey API fails, the pop-ups fail open, the same way the consent
form does, so an outage never locks students out. To stop one failed request
from skipping a mandatory survey for a whole session, each check is retried
(3 attempts, with backoff) and runs again on every page navigation in the
app.

## IRB re-consent prompt (students)

While any student post-survey is prompting in app, a student whose latest
decision is "decline" gets a separate prompt that they can dismiss. It says "A
new study period is starting", asks whether they would reconsider joining,
and offers two buttons:

- **Review consent form** opens the normal consent form. Their new decision
  is recorded as a new consent record, and the latest record counts
  everywhere: research-data gating, the session claim, exports and the
  research pool. If they agree, the mandatory pre-survey follows.
- **No thanks** hides the prompt until a later period's prompt starts.

  The campaign starts at the most recent start time among the post-surveys
  that are currently prompting. The prompt shows only if all of these hold:
  - the student's latest decision is "decline";
  - they made that decision before the campaign started;
  - they haven't said "No thanks" since the campaign started.

  A "decline" made after the campaign starts, including one made in answer
  to this prompt, ends the prompt. Turning off a later period's prompt
  doesn't bring back an earlier one for someone who already said no.

Teachers aren't asked again: a teacher who declined is already blocked from
instructor tools until they agree.

## API

- `GET /api/surveys/due`: the one survey the dashboard should show, either
  `{ state: "NONE" | "CONSENT_PENDING" }` or
  `{ state: "DUE", kind, period, mandatory, form }`.
- `POST /api/surveys/due`: submits a response. The server only accepts the
  form that is currently due. A retried submission of a form the user already
  answered also succeeds.
- `GET/POST /api/surveys/pre` and `.../dismiss`: pre-survey only.
  `dismiss` is still used for "No thanks".
- `GET /api/consent`: now includes `reprompt: { campaignKey, period } | null`.
- `POST /api/consent/reprompt/dismiss`: "No thanks" on the re-consent prompt.
- `PATCH /api/admin/surveys/:id`: also accepts `period` (post-surveys only)
  and `promptInApp`.

The decision rules are pure functions in `src/lib/survey.ts`
(`resolveSurveyGate`, `pickDuePostSurvey`, `isPostSurveyEligible`,
`repromptCampaignKey`, `shouldRepromptConsent`). Their tests are in
`src/lib/survey-periods.test.ts`.

## Exports

- Per-form response CSVs include **Survey** (for example "Period 2
  post-survey") and **Study Period** columns.
- The research dataset export includes `survey_form.period`, `promptInApp` and
  `promptStartedAt`, and a `consent_reprompt_dismissal.csv` file.
