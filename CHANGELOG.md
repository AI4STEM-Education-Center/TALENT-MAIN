# Changelog

## v0.0.20 - 2026-08-28

- Added student and teacher AI chat assistants with streaming replies, file attachments, per-tool administrator configuration, and an answer key gated behind quiz availability.
- Added persistent chat transcripts with a per-user history window and an administrator conversation browser.
- Moved the assistant into the dashboard sidebar as a movable, resizable panel and unblocked stalled conversations.
- Added configurable AI thinking levels, now selected per use case, and an OpenAI Responses transport that falls back automatically when a gateway refuses it.
- Added administrator-issued teacher registration codes with usage limits and expiry, validated during teacher self-registration.
- Improved dashboard accessibility, hook correctness, and build configuration through a React Doctor remediation pass.
- Refreshed the validated production and development dependency sets.

## v0.0.19 - 2026-08-21

- Added signed CloudFront delivery for PDFs and images, with isolated development and production storage paths and browser-safe CORS for PDF figure cropping.
- Expanded simulations with learner feedback, revision workflows, interaction telemetry, and live-version refreshes so students receive the latest available revision.
- Added research-consent workflows, consent exports, database document-backup management, and whole-machine resource monitoring for administrators.
- Expanded grading, learning-material, content-organization, teacher-insight, account, and messaging workflows.
- Improved Safari login persistence and added remembered sessions.
- Hardened quiz, upload, storage, and dependency security, including safer recovery and deployment tooling for the replacement server.

## v0.0.18 - 2026-07-31

- Improved roster emails, invitation workflows, student class discovery, and the default visual theme.
- Expanded teacher-managed simulations and exposed more AI generation timing and token metrics.
- Isolated object-storage paths and added administrator quiz deletion safeguards.
- Personalized and clarified the hosted user guide.

## v0.0.17 - 2026-07-24

- Added the interactive simulation platform, versioned artifact lifecycle, student interaction telemetry, and teacher simulation analytics.
- Expanded administrator operations with reporting, batch quiz import, AI configuration, and richer quiz-authoring workflows.
- Added end-to-end AI generation metrics across supported providers and model configurations.
- Upgraded the application runtime and database tooling while making CI and container builds faster and more reliable.

## v0.0.16 - 2026-07-03

- Added roster CSV workflows, student record editing, clearer statistics navigation, and dark-mode refinements.
- Added per-error misconception tagging and stronger safety checks for the concept catalog.
- Separated background job queues into their own database for safer, more reliable processing.
- Hardened application security and expanded operational documentation.

## v0.0.15 - 2026-06-19

- Added streamed AI responses plus first-token timing, token usage, and local-model image support.
- Added WebDAV database backups, per-request AI timeouts, and refinements to administrator email and PDF review workflows.
- Added per-class quiz settings, expanded teacher statistics, and more holistic learning recommendations.
- Added question-figure support and refreshed the quiz and recommendation interfaces.

## v0.0.14 - 2026-06-14

- Teachers and students can now message each other directly, with email notifications when a new message arrives.
- Students see an in-app notifications badge highlighting new messages and activity.
- Teacher email sending now respects a daily quota to avoid accidental over-sending.
- Faster, more reliable dashboards from a move to server-rendered pages and streamlined Docker/CI builds.
- Security, accessibility, and stability fixes across the app.

## v0.0.13 - 2026-06-12

- Quiz answer choices can now be images, not just text — pulled in automatically when extracting quizzes from PDFs.

## v0.0.12 - 2026-06-11

- Generate quizzes automatically from uploaded PDFs, with a review screen to check and refine the extracted questions before they go live.
- Quiz pools: organize quizzes by topic with topic labels, group them by user, and edit pool entries inline.
- Personalized learning-material recommendations after a quiz, generated in two steps for closer matches.
- Redesigned quiz review and exam-results screens with a unified score summary and clearer recommendations.
- Discover available AI models and edit their settings from the admin AI configuration page.

## v0.0.11 - 2026-06-04

- Share a single learning material across multiple classes.
- Use Cloudflare AI Gateway as an AI provider.
- Themed in-app confirmation and alert dialogs in place of the browser's native popups.

## v0.0.10 - 2026-05-28

- Learning materials reorganized around classes: each class now has its own materials section, and individual materials open in a dedicated viewer.
- Inline editing of learning material titles.
- New material analysis editor for reviewing and refining AI-generated content from uploaded materials.
- New materials processing page in the admin sidebar, with the ability to retry failed material analyses.
- Live processing status updates for uploaded materials, so you can see progress without refreshing.
- Admin dashboard for configuring AI providers and models without redeploying.
- Delete learning materials and cancel in-progress analysis jobs.
- Smoother, more reliable background processing of uploaded materials.
- Faster dashboard loading and cleaner icon styling.
- Bug fixes.

## v0.0.9 - 2026-05-14

- Class roster management: upload student lists by CSV and keep enrollments in sync.
- Enrollment status tracking and filtering on the roster view.
- Admin registration flow and a new admin dashboard with user management and role-based access.

## v0.0.8 - 2026-05-08

- Longer, more detailed AI responses during quiz review.
- Ability to choose between different local chat models.

## v0.0.7 - 2026-04-30

- Import question banks from QTI ZIP files.
- Quiz questions can now be authored in YAML.
- Option to use a local AI provider in addition to OpenAI.

## v0.0.6 - 2026-04-17

- AI-assisted quiz review: chat about your quiz answers after submission.
- Streamlined first-time setup with prebuilt content seeding.

## v0.0.5 - 2026-04-03

- New AI chatbot assistant with streaming, real-time responses.
- Refreshed dashboard layout with improved responsiveness on smaller screens.

## v0.0.4 - 2026-03-27

- Upload learning materials directly in the app, with cloud storage backing.
- Organize uploaded materials into folders.
- File size validation and clearer error messages during upload.

## v0.0.3 - 2026-03-20

- In-app version modal so you can see what's new in each release.
- Expanded supported domains to include ai4talent.org and its subdomains.
- Improved database performance and stability under load.
- Deployment and environment improvements.
- Bug fixes.

## v0.0.2 - 2026-03-13

- Performance and stability improvements.

## v0.0.1 - 2026-03-06

- Complete rewrite of the platform on a modern stack for a faster, smoother experience.
- Fixed an issue where signing out could fail to redirect correctly.
- Bug fixes.

## v0.0.0 - 2026-02-21

- Initial release of the adaptive learning platform with an AI chat assistant.
