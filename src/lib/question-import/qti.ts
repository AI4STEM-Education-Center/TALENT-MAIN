export type ImportedOption = {
  text: string;
  isCorrect: boolean;
};

export type ImportedQuestion = {
  sourceQuestionId?: string;
  title?: string;
  text: string;
  points?: number;
  answerMode: "SINGLE_SELECT" | "MULTI_SELECT";
  feedbackGeneral?: string;
  feedbackCorrect?: string;
  feedbackIncorrect?: string;
  options: ImportedOption[];
};

export type QuestionImportError = {
  index: number;
  sourceQuestionId?: string;
  message: string;
};

export type ParsedQuestionBank = {
  bankId?: string;
  bankTitle?: string;
  questions: ImportedQuestion[];
  errors: QuestionImportError[];
};

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value))
    return Math.trunc(value);
  return undefined;
}

function cleanAnswerMode(
  value: unknown,
): ImportedQuestion["answerMode"] | undefined {
  return value === "SINGLE_SELECT" || value === "MULTI_SELECT"
    ? value
    : undefined;
}

function directChild(element: Element, tagName: string): Element | null {
  return (
    Array.from(element.children).find((child) => child.localName === tagName) ??
    null
  );
}

function firstDescendant(element: Element, tagName: string): Element | null {
  return Array.from(element.getElementsByTagName(tagName))[0] ?? null;
}

function textFromFirstMatText(
  element: Element,
  parser: DOMParser,
): string | undefined {
  const matText = firstDescendant(element, "mattext");
  return cleanString(
    matText?.textContent
      ? normalizeQtiText(matText.textContent, parser)
      : undefined,
  );
}

function normalizeQtiText(value: string, parser: DOMParser): string {
  const normalizedParagraphs = value
    .replace(/<\/p>\s*<p/gi, "</p>\n<p")
    .replace(/<br\s*\/?>/gi, "\n");

  if (!normalizedParagraphs.includes("<")) {
    return normalizedParagraphs.replace(/\s+/g, " ").trim();
  }

  const html = parser.parseFromString(normalizedParagraphs, "text/html");
  return (html.body.textContent ?? "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function metadataValue(item: Element, label: string): string | undefined {
  const fields = Array.from(item.getElementsByTagName("qtimetadatafield"));
  for (const field of fields) {
    const fieldLabel = firstDescendant(
      field,
      "fieldlabel",
    )?.textContent?.trim();
    if (fieldLabel !== label) continue;
    return cleanString(firstDescendant(field, "fieldentry")?.textContent);
  }

  return undefined;
}

function hasAncestorNamed(
  element: Element,
  tagName: string,
  stopAt: Element,
): boolean {
  let current = element.parentElement;
  while (current && current !== stopAt) {
    if (current.localName === tagName) return true;
    current = current.parentElement;
  }
  return false;
}

function correctResponseIds(item: Element): Set<string> {
  const correctIds = new Set<string>();
  const resprocessing = firstDescendant(item, "resprocessing");
  if (!resprocessing) return correctIds;

  for (const varequal of Array.from(
    resprocessing.getElementsByTagName("varequal"),
  )) {
    if (hasAncestorNamed(varequal, "not", resprocessing)) continue;
    const value = cleanString(varequal.textContent);
    if (value) correctIds.add(value);
  }

  return correctIds;
}

function feedbackText(
  item: Element,
  ident: string,
  parser: DOMParser,
): string | undefined {
  const feedback = Array.from(item.getElementsByTagName("itemfeedback")).find(
    (entry) => entry.getAttribute("ident") === ident,
  );
  return feedback ? textFromFirstMatText(feedback, parser) : undefined;
}

function parseQtiQuestion(
  item: Element,
  index: number,
  parser: DOMParser,
): ImportedQuestion | QuestionImportError {
  const sourceQuestionId = cleanString(item.getAttribute("ident"));
  const presentation = directChild(item, "presentation");
  const responseLid = presentation
    ? firstDescendant(presentation, "response_lid")
    : null;
  const renderChoice = responseLid
    ? firstDescendant(responseLid, "render_choice")
    : null;
  const text = presentation
    ? textFromFirstMatText(presentation, parser)
    : undefined;
  const correctIds = correctResponseIds(item);

  const options = renderChoice
    ? Array.from(renderChoice.getElementsByTagName("response_label"))
        .map((label) => {
          const optionText = textFromFirstMatText(label, parser);
          const ident = cleanString(label.getAttribute("ident"));
          if (!optionText || !ident) return null;
          return { text: optionText, isCorrect: correctIds.has(ident) };
        })
        .filter((option): option is ImportedOption => option !== null)
    : [];

  const correctCount = options.filter((option) => option.isCorrect).length;
  if (!text)
    return { index, sourceQuestionId, message: "Question text is required." };
  if (options.length < 2)
    return {
      index,
      sourceQuestionId,
      message: "At least 2 answer choices are required.",
    };
  if (correctCount < 1)
    return {
      index,
      sourceQuestionId,
      message: "At least one answer choice must be correct.",
    };

  const questionType = metadataValue(item, "question_type");
  const cardinality = responseLid?.getAttribute("rcardinality");

  return {
    sourceQuestionId,
    title: cleanString(item.getAttribute("title")),
    text,
    answerMode:
      cardinality === "Multiple" ||
      questionType === "multiple_answers_question" ||
      correctCount > 1
        ? "MULTI_SELECT"
        : "SINGLE_SELECT",
    feedbackGeneral: feedbackText(item, "general_fb", parser),
    feedbackCorrect: feedbackText(item, "correct_fb", parser),
    feedbackIncorrect: feedbackText(item, "general_incorrect_fb", parser),
    options,
  };
}

export function parseQtiQuestionBank(contents: string): ParsedQuestionBank {
  const parser = new DOMParser();
  const document = parser.parseFromString(contents, "application/xml");
  const parserError = document.getElementsByTagName("parsererror")[0];
  if (parserError)
    throw new Error(
      parserError.textContent?.trim() || "Could not parse QTI XML.",
    );

  const assessment = document.getElementsByTagName("assessment")[0];
  if (!assessment) throw new Error("QTI XML must contain an assessment.");

  const questions: ImportedQuestion[] = [];
  const errors: QuestionImportError[] = [];
  const section = document.getElementsByTagName("section")[0] ?? assessment;
  const items = Array.from(section.getElementsByTagName("item"));

  items.forEach((item, index) => {
    const parsed = parseQtiQuestion(item, index, parser);
    if ("message" in parsed) {
      errors.push(parsed);
      return;
    }
    questions.push(parsed);
  });

  return {
    bankId: cleanString(assessment.getAttribute("ident")),
    bankTitle: cleanString(assessment.getAttribute("title")),
    questions,
    errors,
  };
}

export function validateParsedQuestionBank(input: unknown): ParsedQuestionBank {
  if (!isRecord(input))
    throw new Error("Import payload must contain a parsed question bank.");

  const rawQuestions = input.questions;
  if (!Array.isArray(rawQuestions))
    throw new Error("Import payload must contain a questions array.");
  if (rawQuestions.length > 5_000)
    throw new Error("Import payload cannot contain more than 5,000 questions.");

  const questions: ImportedQuestion[] = rawQuestions.map((entry, index) => {
    if (!isRecord(entry))
      throw new Error(`Question ${index + 1} must be an object.`);

    const text = cleanString(entry.text);
    const answerMode = cleanAnswerMode(entry.answerMode);
    const rawOptions = entry.options;
    if (!text) throw new Error(`Question ${index + 1} is missing text.`);
    if (text.length > 10_000)
      throw new Error(`Question ${index + 1} text is too long.`);
    if (!answerMode)
      throw new Error(`Question ${index + 1} has an invalid answer mode.`);
    if (!Array.isArray(rawOptions))
      throw new Error(`Question ${index + 1} must include options.`);
    if (rawOptions.length > 20)
      throw new Error(
        `Question ${index + 1} cannot include more than 20 options.`,
      );

    const options = rawOptions.map((option, optionIndex) => {
      if (!isRecord(option))
        throw new Error(
          `Question ${index + 1}, option ${optionIndex + 1} must be an object.`,
        );
      const optionText = cleanString(option.text);
      if (!optionText)
        throw new Error(
          `Question ${index + 1}, option ${optionIndex + 1} is missing text.`,
        );
      if (optionText.length > 2_000)
        throw new Error(
          `Question ${index + 1}, option ${optionIndex + 1} is too long.`,
        );
      return { text: optionText, isCorrect: option.isCorrect === true };
    });

    if (options.length < 2)
      throw new Error(`Question ${index + 1} must include at least 2 options.`);
    if (!options.some((option) => option.isCorrect)) {
      throw new Error(
        `Question ${index + 1} must include at least one correct option.`,
      );
    }

    return {
      sourceQuestionId: cleanString(entry.sourceQuestionId),
      title: cleanString(entry.title),
      text,
      points: cleanNumber(entry.points),
      answerMode,
      feedbackGeneral: cleanString(entry.feedbackGeneral),
      feedbackCorrect: cleanString(entry.feedbackCorrect),
      feedbackIncorrect: cleanString(entry.feedbackIncorrect),
      options,
    };
  });

  const errors: QuestionImportError[] = [];
  if (Array.isArray(input.errors)) {
    input.errors.forEach((entry, index) => {
      if (!isRecord(entry)) return;
      const message = cleanString(entry.message);
      if (!message) return;
      const sourceQuestionId = cleanString(entry.sourceQuestionId);
      errors.push({
        index:
          typeof entry.index === "number" && Number.isInteger(entry.index)
            ? entry.index
            : index,
        ...(sourceQuestionId ? { sourceQuestionId } : {}),
        message,
      });
    });
  }

  return {
    bankId: cleanString(input.bankId),
    bankTitle: cleanString(input.bankTitle),
    questions,
    errors,
  };
}
