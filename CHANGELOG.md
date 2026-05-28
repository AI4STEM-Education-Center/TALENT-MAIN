# Changelog

## v0.0.17 - 2026-05-28

- Inline editing of learning material titles.
- Live processing status updates for uploaded materials, so you can see progress without refreshing.
- New materials processing page in the admin sidebar, with the ability to retry failed material analyses.
- Bug fixes.

## v0.0.16 - 2026-05-26

- New material analysis editor for reviewing and refining AI-generated content from uploaded materials.
- Faster dashboard loading and cleaner icon styling.
- Bug fixes.

## v0.0.15 - 2026-05-24

- Learning materials reorganized around classes: each class now has its own materials section, and individual materials open in a dedicated viewer.
- Admin dashboard for configuring AI providers and models without redeploying.
- Delete learning materials and cancel in-progress analysis jobs.
- Smoother, more reliable background processing of uploaded materials.
- Bug fixes.

## v0.0.14 - 2026-05-14

- Class roster management: upload student lists by CSV and keep enrollments in sync.
- Enrollment status tracking and filtering on the roster view.
- Admin registration flow and a new admin dashboard with user management and role-based access.

## v0.0.13 - 2026-05-08

- Longer, more detailed AI responses during quiz review.
- Ability to choose between different local chat models.

## v0.0.12 - 2026-04-30

- Import question banks from QTI ZIP files.
- Quiz questions can now be authored in YAML.
- Option to use a local AI provider in addition to OpenAI.

## v0.0.11 - 2026-04-17

- AI-assisted quiz review: chat about your quiz answers after submission.
- Streamlined first-time setup with prebuilt content seeding.

## v0.0.10 - 2026-04-03

- New AI chatbot assistant with streaming, real-time responses.
- Refreshed dashboard layout with improved responsiveness on smaller screens.

## v0.0.9 - 2026-03-27

- Upload learning materials directly in the app, with cloud storage backing.
- Organize uploaded materials into folders.
- File size validation and clearer error messages during upload.

## v0.0.16 - 2026-05-26

- Updated Dockerfile base image and dependencies for improved build stability.
- Added worker service configuration and standardized volume paths in Docker Compose (dev/prod).
- Added honker-node to Next.js server external packages.
- Removed obsolete LearningMaterial migration fixes (folder column and pre-migration cleanup).

## v0.0.15 - 2026-05-24

- Migrated to SQLite and introduced a honker-based background worker with concurrency optimizations.
- Implemented database-backed AI configuration with admin dashboard controls.
- Restructured learning materials flow with class-scoped routing and detail page viewing; added materials section to class detail page.
- Added material deletion, job cancellation, and migration safeguards for existing LearningMaterial data.
- Implemented a custom ReadableStream for Server-Sent Events in the chat API route.
- Updated AI model schema constraints and switched to `max_completion_tokens` with expanded connection test prompts/limits.
- Added lazy initialization for the OpenAI client to reduce resource usage.

## v0.0.14 - 2026-05-14

- Added /admin-register to the list of public routes in proxy middleware.
- Implemented admin registration, dashboard, user management, and authorization system.
- Added enrollment status tracking and filtering to student roster and migrated classes list to client-side data fetching.
- Implemented class roster management with CSV upload support and student list synchronization.

## v0.0.13 - 2026-05-08

- Increased max completion tokens for quiz review and enhanced message handling in Chatbot.
- Enhanced chat API to support max_tokens for local provider.
- Enhanced local chat model selection and API integration.

## v0.0.12 - 2026-04-30

- Implemented QTI ZIP file import functionality for question management.
- Normalized inline block scalar headers in YAML parsing.
- Added YAML support and enhanced question handling in quiz functionality.
- Enhanced authentication and chat functionality with local API support.

## v0.0.11 - 2026-04-17

- Updated dependencies and enhanced chat functionality.
- Enhanced chat API and UI for quiz review functionality.
- Added prebuilt seeding functionality and updated deployment workflow.

## v0.0.10 - 2026-04-03

- Updated default OpenAI service tier to flex and model to gpt-5.4.
- Added debug logging for OpenAI API configuration in chat route.
- Implemented streaming responses with retry logic and performance metrics in chat API and UI.
- Implemented AI chatbot component with OpenAI API integration.
- Enhanced dashboard layout and UI components for improved responsiveness.

## v0.0.9 - 2026-03-27

- Added folder support to learning materials and enhanced UI for organization.
- Improved error handling in MaterialUploadForm and API routes.
- Enhanced MaterialUploadForm with file size validation and cleanup logic.
- Implemented learning materials upload feature with S3 integration.

## v0.0.8 - 2026-03-20

- In-app version modal so you can see what's new in each release.
- Expanded supported domains to include ai4talent.org and its subdomains.

## v0.0.7 - 2026-03-18

- Improved database performance and stability under load.

## v0.0.6 - 2026-03-18

- Bug fixes.

## v0.0.5 - 2026-03-18

- Deployment and environment improvements.

## v0.0.4 - 2026-03-13

- Performance and stability improvements.

## v0.0.3 - 2026-03-06

- Fixed an issue where signing out could fail to redirect correctly.

## v0.0.2 - 2026-03-06

- Bug fixes.

## v0.0.1 - 2026-03-06

- Complete rewrite of the platform on a modern stack for a faster, smoother experience.
- Bug fixes.

## v0.0.0 - 2026-02-21

- Initial release of the adaptive learning platform with an AI chat assistant.
