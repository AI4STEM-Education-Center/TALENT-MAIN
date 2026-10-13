// Explicit field allowlist: new schema fields require a research/security review
// before they can enter an export. Names are Prisma names, including @map fields.
export const RESEARCH_EXPORT_FIELDS = {
  User: "id email username firstName lastName role createdAt",
  Teacher: "id userId emailDailyLimit emailMonthlyLimit",
  LearningMaterial:
    "id teacherId classId topicId sourceMaterialId title originalName mimeType sizeBytes storageKey bucket uploadStatus processingStatus folder totalPages processedPages errorMessage batchDescription batchKeyConcepts aiModel aiProvider aiServiceTier aiThinkingLevel aiTtftMs aiTokens aiTotalMs createdAt updatedAt",
  MaterialClass: "id materialId classId createdAt",
  MaterialPage:
    "id materialId pageNumber storageKey needed keyConcept description createdAt",
  Student: "id userId",
  Class: "id name description teacherId createdAt modulesRevision",
  ClassSyllabus:
    "id classId teacherId revision sourceRevision pendingStorageKey pendingName originalName sizeBytes storageKey bucket totalPages pageKeys status errorMessage warnings content extractedAt editedAt aiModel aiProvider aiServiceTier aiThinkingLevel aiTtftMs aiTokens aiTotalMs createdAt updatedAt",
  ClassStudentList:
    "id classId orgDefinedId firstName lastName email isRegistered createdAt",
  ClassEnrollment: "id classId studentId joinedAt",
  Invitation: "id classId expiresAt maxUses usedCount active createdAt",
  TeacherRegistrationCode:
    "id label expiresAt maxUses usedCount active createdAt createdById lastUsedAt",
  Topic: "id name order contentType teacherId createdAt updatedAt",
  Quiz: "id name order topicId teacherId sourceQuizId createdAt updatedAt",
  PoolSubmission:
    "id contentType status teacherId reviewerId quizId materialId topicId decisionNote emailStatus emailError decidedAt createdAt updatedAt",
  Question:
    "id title text quizId difficultyLevel answerMode order points feedbackGeneral feedbackCorrect feedbackIncorrect sourceQuestionId importId createdById createdAt updatedAt answerNumeric answerTolerance answerUnit figureStorageKey figureBucket figureAlt",
  QuestionImport:
    "id teacherId quizId originalName sourcePath bankId bankTitle status importedCount skippedCount errorCount errors createdAt updatedAt",
  QuizPdfExtraction:
    "id quizId teacherId createdByUserId originalName sizeBytes storageKey bucket status totalPages errorMessage hasAnswerKey extractedQuestions warnings guardrailEventId questionImportId aiModel aiProvider aiServiceTier aiThinkingLevel aiTtftMs aiTokens aiTotalMs createdAt updatedAt",
  QuizPdfExtractionPage: "id extractionId pageNumber storageKey",
  QuizPdfExtractionFigure:
    "id extractionId questionIndex optionIndex storageKey createdAt",
  Option: "id text isCorrect questionId imageStorageKey imageBucket imageAlt",
  ClassModule: "id classId name description position",
  ClassModuleQuiz: "moduleId classQuizId position",
  ClassQuiz:
    "id classId quizId published availableFrom availableUntil maxAttempts",
  QuizProgress:
    "id studentId classId quizId status bestScore manualGrade updatedAt",
  QuizAttempt: "id studentId classId quizId score startedAt completedAt",
  QuizAnswer:
    "id quizAttemptId questionId selectedOptionId selectedOptionIds numericValue isCorrect",
  ExamResult:
    "id quizAttemptId studentId classId quizId studentName className topicName quizName score correctCount totalCount completedAt reviewSnapshot summary summaryStatus recommendations recommendationsStatus aiModel summaryAiModel summaryAiProvider summaryServiceTier summaryThinkingLevel summaryTtftMs summaryGenerationMs summaryTotalMs summaryTokens summaryTokensEstimated recsAiModel recsAiProvider recsServiceTier recsThinkingLevel recsTtftMs recsGenerationMs recsTotalMs recsTokens recsTokensEstimated createdAt updatedAt",
  AiProvider:
    "id name providerType cfAigByokAlias timeoutMs apiSurface isActive createdAt updatedAt",
  AiModel:
    "id providerId modelId displayName serviceTier thinkingLevel isDefault createdAt",
  AiUseCaseAssignment:
    "id useCase providerId modelId thinkingLevel createdAt updatedAt",
  GuardrailConfig:
    "id moderationEnabled jailbreakMode offTopicMode jailbreakThreshold offTopicThreshold topicDescription failOpen disabledSurfaces updatedAt",
  GuardrailEvent: "id createdAt surface subjectId userId blocked reasons",
  GuardrailFeedback:
    "id createdAt eventId userId message status reviewedAt reviewedBy",
  AssistantConfig:
    "id audience enabled extraInstructions enabledSkills disabledTools attachmentKinds maxAttachments maxAttachmentBytes attachmentRetentionDays historyRetentionDays maxToolCalls maxHistoryMessages turnsPerHour knownSkills createdAt updatedAt",
  AssistantAttachment:
    "id userId audience name mimeType kind bytes storageKey bucket createdAt expiresAt",
  AssistantConversation:
    "id userId audience title messageCount createdAt lastMessageAt archivedAt storageKey bucket",
  AssistantMessage:
    "id conversationId seq role content attachmentIds attachmentNames createdAt",
  EmailSender:
    "id purpose localPart fromName replyTo subject body createdAt updatedAt",
  Message:
    "id classId direction channels senderUserId subject body recipientCount sentCount inAppCount status error createdAt",
  MessageEmailDelivery:
    "id messageId userId email status attempts lastError nextAttemptAt claimedAt sentAt createdAt updatedAt",
  Notification: "id messageId userId readAt createdAt",
  Concept:
    "id conceptId kind parentApLo unit topic displayName description sourceLoCode comments notes url deprecated deprecationNote createdAt updatedAt",
  Misconception:
    "id misconceptionId statement sourceCitation link sourceType notes deprecated deprecationNote createdAt updatedAt",
  ConceptMisconception:
    "id misconceptionId conceptId confidence notes createdAt",
  ConceptExternalRef: "id conceptId refCode refType sourceUrl createdAt",
  QuestionSimulation:
    "id questionId status topic title learningGoal declineReason errorMessage storageKey bucket version simSpec sourceSimulationId aiModel aiProvider aiServiceTier aiThinkingLevel aiTtftMs aiGenerationMs aiTotalMs aiTokens aiTokensEstimated createdAt updatedAt",
  SimulationFeedback:
    "id simulationId authorUserId authorName feedback status errorMessage previousStorageKey baseVersion versionName createdAt updatedAt",
  SimulationSession:
    "id simulationId studentId classId quizId attemptId surface startedAt endedAt dwellMs activeMs interactionCount paramChanges controlsJson updatedAt",
  ContentFeedback:
    "id createdAt updatedAt audience subjectType rating comment authorUserId authorName authorEmail authorRole subjectId subjectLabel subjectDetail subjectKey routedTeacherId attemptId quizId quizName classId className",
  SystemLog: "id createdAt category type severity message userId ip metadata",
  ResourceSample:
    "id createdAt nodeId appEnv role hostname cpuPercent cpuCores memUsedBytes memLimitBytes dbBytes diskTotalBytes diskFreeBytes s3Bytes",
  ConsentFormVersion:
    "id role version title bodyHtml isActive createdAt createdById",
  ConsentRecord:
    "id userId role formVersionId decision interviewRecordingConsent interviewRecordingChoice initialsStrokeData ugaId signatureTypedName signatureStrokeData signedAt ipAddress userAgent deviceType signerNameSnapshot signerEmailSnapshot emailedAt emailStatus emailError",
  ConsentExportRequest:
    "id teacherId classId gradeColumnName pointsAwarded reviewerId status courseEndedAttested decisionNote decidedAt requestedAt deliveredAt emailStatus emailError",
  ConsentEmailDelivery:
    "id kind recipient status attempts lastError nextAttemptAt claimedAt sentAt createdAt",
  ConsentExportJob:
    "id requestedById filter status totalRecords processedRecords resultBucket resultKey resultBytes expiresAt error createdAt completedAt",
  ConsentExportSettings:
    "id maxEmailAttachmentBytes bulkExportBatchSize bulkExportInlineThreshold bulkExportMaxRecords bulkExportRetentionHours updatedAt updatedById",
  PressureTestResult:
    "id runId createdAt startedAt finishedAt environment suite scenario status source commitSha branch targetUrl durationMs totalChecks passedChecks failedChecks p50Ms p95Ms p99Ms maxMs requestRate virtualUsers errorRate metadata metrics failures",
  SimulationVersion:
    "id simulationId number name parentNumber storageKey bucket createdAt",
  SimulationEditChat:
    "id simulationId userId baseVersion transcript plan state updatedAt",
  QuizPracticeVersion:
    "id quizId name status variation sourceSnapshot objectives questions validation error aiModel aiTokens batchId purpose feedback revisedFromId standaloneQuizId attempts teacherEdited createdAt updatedAt",
  QuizPracticeAttempt:
    "id studentId classId quizId versionId versionName questions answers score startedAt completedAt activeKey",
  SurveyForm:
    "id kind role title description questions isEnabled status errorMessage sourceText pdfBucket pdfKey pdfName createdById createdAt updatedAt",
  SurveyResponse:
    "id formId userId kind role answers interviewOptIn interviewEmail irbAgreed source nameSnapshot emailSnapshot submittedAt",
  SurveyPromptDismissal: "id userId formId dismissedAt",
  SurveyInvite:
    "id formId userId email name campaignId createdAt usedAt responseId",
  ResearchEmailTemplate:
    "kind replyTo versions irbSubject irbBody surveySubject surveyBody attachments audience updatedAt updatedById",
  ResearchEmailCampaign:
    "id kind replyTo versions irbSubject irbBody surveySubject surveyBody attachments audience appOrigin status scheduledAt startedAt completedAt error createdById createdAt",
  ResearchEmailDelivery:
    "id campaignId userId recipient variant status attempts lastError nextAttemptAt claimedAt sentAt createdAt",
} as const;

export const RESEARCH_EXPORT_EXCLUDED_MODELS = [
  "PasswordResetToken",
  "SmtpConfig",
  "BackupConfig",
  "PressureResultToken",
];
