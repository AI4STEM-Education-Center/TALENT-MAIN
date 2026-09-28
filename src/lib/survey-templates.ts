// The four study instruments (student/teacher × pre/post), transcribed by hand
// from the research team's PDFs so they render faithfully — Likert grids and
// inline checkbox rows don't survive PDF text extraction reliably. Seeded as
// disabled forms (prisma/seed-consent.ts) and offered in the admin survey page
// as "Add from built-in template". Wording is verbatim, typos included, since
// the approved instruments are what participants must see.

import type { SurveyKind, SurveyQuestion, SurveyRole } from "@/lib/survey";

export type SurveyTemplate = {
  key: string;
  kind: SurveyKind;
  role: SurveyRole;
  title: string;
  description: string;
  questions: SurveyQuestion[];
};

type Draft = Partial<SurveyQuestion> & Pick<SurveyQuestion, "type" | "text">;

function build(prefix: string, drafts: Draft[]): SurveyQuestion[] {
  let n = 0;
  let s = 0;
  return drafts.map((d) => ({
    id: d.type === "section" ? `${prefix}s${++s}` : `${prefix}q${++n}`,
    help: "",
    options: [],
    otherLabel: "",
    required: d.type !== "section",
    ...d,
  }));
}

const section = (text: string, help = ""): Draft => ({
  type: "section",
  text,
  help,
});
const single = (text: string, options: string[], otherLabel = ""): Draft => ({
  type: "single",
  text,
  options,
  otherLabel,
});
const scale = (text: string, options: string[]): Draft => ({
  type: "likert",
  text,
  options,
});
const openText = (text: string, required = true): Draft => ({
  type: "textarea",
  text,
  required,
});

const AGREE_5 = [
  "1 - Strongly Disagree",
  "2 - Disagree",
  "3 - Neutral",
  "4 - Agree",
  "5 - Strongly Agree",
];
/** The instructor pre-survey grid only labels its endpoints. */
const AGREE_ENDPOINTS = [
  "1 - Strongly disagree",
  "2",
  "3",
  "4",
  "5 - Strongly agree",
];
const FREQUENCY = ["Never", "Once or twice", "A few times", "Many times"];
const DOES_NOT_APPLY = "Leave blank if this does not apply.";

const STUDENT_PRE: SurveyTemplate = {
  key: "student-pre",
  kind: "PRE",
  role: "STUDENT",
  title: "Student Usability Survey – Pre Session Survey",
  description:
    "Welcome! Thank you for taking the time to be part of this research project. We are trying to learn more about how new AI (Artificial Intelligence) tools can help students learn.\n\nBefore we start with other activities, we have a few general questions about you. This information helps us understand the different backgrounds of students participating in this study.",
  questions: build("sp", [
    section("Demographic Information"),
    single("Number of year(s) as a student at UGA", [
      "First Year",
      "Second Year",
      "Third Year",
      "Four or More Years",
    ]),
    single(
      "Which best describes you?",
      ["Female", "Male", "Non-binary", "Prefer not to say"],
      "Prefer to self-describe",
    ),
    single(
      "Do you have regular access to a computer or tablet for schoolwork at home?",
      ["Yes — my own device", "Yes — shared device", "No"],
    ),
    single(
      "Does your home internet usually work well enough for school activities?",
      ["Yes", "Sometimes", "No"],
    ),
    single(
      "Do you know any rules your physics course has about using AI tools in class?",
      ["Yes", "No"],
    ),
    single(
      "If you need help with technology, who do you usually ask first?",
      [
        "Teachers",
        "Classmate/friend",
        "Relative",
        "Traditional web search (Google,Bing, etc.)",
        "AI tool (ChatGPT, Genimi, etc.)",
      ],
      "Other",
    ),
    section("Prior Experience with Similar Learning Tools (Feasibility)"),
    single(
      "How much time do you spend using digital devices (e.g., computer, iPad, Smart phone) for schoolwork each week?",
      ["Less than 1 hour", "1–3 hours", "4–6 hours", "More than 6 hours"],
    ),
    single(
      "Have you used an online learning platform before (e.g., PhET, Khan Academy or other)?",
      FREQUENCY,
    ),
    scale(
      "How frequently do you use AI tools (like ChatGPT or other AI helpers) for schoolwork each week?",
      FREQUENCY,
    ),
    scale(
      "How comfortable do you feel using new learning platforms /apps without help?",
      [
        "Not comfortable",
        "A little comfortable",
        "Somewhat comfortable",
        "Comfortable",
        "Very comfortable",
      ],
    ),
    scale(
      "How confident are you at finding information using a web search (Google/Bing)?",
      [
        "Not confident",
        "A little",
        "Somewhat confident",
        "Confident",
        "Very confident",
      ],
    ),
    scale(
      "How confident are you at interacting with generative AI tools for learning (i.e., ChatGPT)?",
      ["Not confident", "A little", "Somewhat", "Confident", "Very confident"],
    ),
  ]),
};

const TEACHER_PRE: SurveyTemplate = {
  key: "teacher-pre",
  kind: "PRE",
  role: "TEACHER",
  title: "Instructor Pre-Implementation Survey",
  description: "",
  questions: build("tp", [
    section("Section 1: Demographic Information"),
    single(
      "How many years have you been teaching (including the current school year)?",
      ["under 1", "1-5", "5-10", "10+"],
    ),
    { type: "text", text: "What courses are you teaching this semester?" },
    single("Which best describes you?", [
      "Male",
      "Female",
      "Non-binary",
      "Prefer not to say",
    ]),
    openText(
      "List all the AI tools you have used in teaching (e.g. ChatGPT, Magic School AI, ...):",
    ),
    openText("List the purposes for which you used AI tools in your teaching:"),
    section("Section 2: Perceptions/Acceptance", "Perceptions of AI"),
    section("Perceived Usefulness"),
    scale(
      "AI tools can improve the effectiveness of my teaching.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "AI tools can help me create more engaging and personalized learning experiences for my students",
      AGREE_ENDPOINTS,
    ),
    scale(
      "AI tools can save me time by automating routine teaching and administrative tasks.",
      AGREE_ENDPOINTS,
    ),
    section("Perceived Ease of Use"),
    scale(
      "It is easy for me to learn to use AI tools for teaching.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "Most AI tools are user-friendly and intuitive to operate.",
      AGREE_ENDPOINTS,
    ),
    scale("I can quickly become skillful at using AI tools.", AGREE_ENDPOINTS),
    section("AI Self-Efficacy"),
    scale("I feel confident using AI tools for teaching.", AGREE_ENDPOINTS),
    scale(
      "I can evaluate whether AI-generated content suits my students’ needs.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I can troubleshoot basic problems when using AI tools.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I feel like I use AI for teaching related tasks more than my colleagues",
      AGREE_ENDPOINTS,
    ),
    section("AI Acceptance", "Behavioral intention to use AI"),
    scale(
      "I will use AI tools to support my teaching and student learning.",
      AGREE_ENDPOINTS,
    ),
    scale("I will explore more AI tools whenever needed.", AGREE_ENDPOINTS),
    scale(
      "I encourage colleagues to try AI tools in their teaching.",
      AGREE_ENDPOINTS,
    ),
    section("Anxiety toward AI use"),
    scale(
      "I have ethical concerns when using AI tools in my teaching.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I have low confidence in interacting with AI technologies.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I fear that AI might replace some aspects of my teaching role.",
      AGREE_ENDPOINTS,
    ),
    section("Section 3: Knowledge", "Technological knowledge"),
    scale(
      "I can explain how AI differs from traditional educational technologies.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I am familiar with common generative AI tools (e.g., ChatGPT, Copilot).",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I can effectively use prompts to interact with generative AI tools.",
      AGREE_ENDPOINTS,
    ),
    section("Pedagogical knowledge"),
    scale(
      "I know how to use AI tools to enhance student learning.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I know which teaching tasks AI can and cannot perform effectively.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I can use AI tools to develop instructions that align with my instructional goals or subject area.",
      AGREE_ENDPOINTS,
    ),
    section("Ethical and responsible AI use"),
    scale(
      "I understand key ethical issues such as bias and plagiarism in AI use.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I can guide students to use AI responsibly and avoid academic dishonesty.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I can use AI responsibly to support my instruction.",
      AGREE_ENDPOINTS,
    ),
    scale(
      "I think students in my class mainly use AI to improve their understanding",
      AGREE_ENDPOINTS,
    ),
    section("Section 4: Practice & AI Innovation", DOES_NOT_APPLY),
    openText(
      "How do you currently gather information about AI (e.g., through PD, colleagues, or reading), and what are your initial impressions of its potential for your classroom?",
      false,
    ),
    openText(
      "To what extent do you typically modify AI-generated materials before using them with students? Please provide one specific example of a change you made.",
      false,
    ),
    openText(
      "Describe how your classroom routines have shifted to make AI as a partner in your daily practice.",
      false,
    ),
    openText(
      "In what ways have you influenced the AI practices of your colleagues or contributed to the development of your school’s AI policy and culture?",
      false,
    ),
    openText(
      "What has made it easier or harder to use AI in your teaching context, and what support do you need from the AI4Talent team moving forward?",
      false,
    ),
  ]),
};

const STUDENT_POST: SurveyTemplate = {
  key: "student-post",
  kind: "POST",
  role: "STUDENT",
  title: "Student Post-Implementation Survey",
  description:
    "Please indicate how much you agree with each statement below using the following scale:\n1 = Strongly Disagree, 2 = Disagree, 3 = Neutral, 4 = Agree, 5 = Strongly Agree",
  questions: build("so", [
    section("Usability"),
    scale("AI4Talent had all the tools and features I needed.", AGREE_5),
    scale("AI4Talent was easy to use.", AGREE_5),
    scale(
      "The wait time for the AI generated recommendations/responses in the platform was acceptable.",
      AGREE_5,
    ),
    scale(
      "I found the AI generated recommendations/responses helpful.",
      AGREE_5,
    ),
    scale(
      "I experienced very few technical problems using the platform.",
      AGREE_5,
    ),
    section("Feasibility"),
    scale(
      "AI4Talent worked seamlessly with UGA’s IT infrastructure and internet connectivity.",
      AGREE_5,
    ),
    scale(
      "I would continue to use AI4Talent in future courses if it remains available.",
      AGREE_5,
    ),
    scale(
      "The support provided were adequate for me to feel prepared to use AI4Talent.",
      AGREE_5,
    ),
    section("Engagement"),
    scale(
      "AI4Talent helped me stay organized and focused while learning.",
      AGREE_5,
    ),
    scale(
      "AI4Talent helped me improve my understanding of the physics content.",
      AGREE_5,
    ),
    scale("AI4Talent helped me earn a higher grade on my exams.", AGREE_5),
    section("Suggestions for Improvement"),
    openText("What features of the platform did you find most helpful?"),
    openText(
      "How could the platform be improved to better support your learning?",
    ),
    openText(
      "Among all the tasks you tried on the platform, did any need more improvement than others? If so, which one(s)? Why?",
    ),
    openText(
      "What feature do you wish AI4Talent had that it currently does not?",
    ),
  ]),
};

const TEACHER_POST: SurveyTemplate = {
  key: "teacher-post",
  kind: "POST",
  role: "TEACHER",
  title: "Instructor Post-Implementation Survey",
  description: "",
  questions: build("to", [
    section("Part 1: Platform Acceptance & Usability"),
    scale("I enjoyed integrating AI4Talent into my course.", AGREE_5),
    scale(
      "The effort required to prepare for and use AI4Talent was manageable within my existing schedule.",
      AGREE_5,
    ),
    scale(
      "I clearly understood how AI4Talent is intended to support student learning.",
      AGREE_5,
    ),
    scale(
      "The teacher dashboard significantly improved my ability to monitor students’ engagement with AI4Talent.",
      AGREE_5,
    ),
    scale(
      "AI4Talent allowed me to complete tasks without technical frustration.",
      AGREE_5,
    ),
    scale(
      "The level effort to set up and use AI4Talent for my course compared to similar existing platforms (e.g., TopHat, publisher’s homework system) was:",
      [
        "1 - A lot less effort",
        "2 - Slightly less effort",
        "3 - About the same",
        "4 - Slightly more effort",
        "5 - At lot more effort",
      ],
    ),
    section("Part 2: Functionality"),
    scale("The AI4TALENT platform was straightforward to navigate.", AGREE_5),
    scale(
      "It was easy to import student roster information into the AI4TALENT platform.",
      AGREE_5,
    ),
    scale(
      "It was easy to upload course materials, including assessments and slides, into the AI4Talent platform.",
      AGREE_5,
    ),
    scale(
      "The organization of information on the platform was very clear.",
      AGREE_5,
    ),
    scale("The AI4TALENT platform ran smoothly for my course.", AGREE_5),
    scale(
      "I need additional technical support or training to use the AI4TALENT platform effectively.",
      AGREE_5,
    ),
    section("Part 3: Feasibility & Sustainability"),
    scale(
      "AI4Talent worked seamlessly with UGA’s IT infrastructure and internet connectivity.",
      AGREE_5,
    ),
    scale(
      "The activities and resources aligned well with the physics content I teach.",
      AGREE_5,
    ),
    scale(
      "I would continue to use AI4Talent in future courses if it remains available.",
      AGREE_5,
    ),
    scale(
      "The support provided were adequate for me to feel prepared to implement AI4Talent.",
      AGREE_5,
    ),
    openText(
      "Was there anything missing in the platform that you would have liked to have included?",
    ),
    section("Part 4: Reflection."),
    openText(
      "Do you have any specific feedback for further improvements to AI4Talent (the interface, tools, or navigation)?",
    ),
    openText(
      "Describe the most “innovative” moment you experienced with AI4Talent. This might be an activity, interaction, or student response that you feel would not have been possible without the AI4Talent (if any).",
    ),
    openText(
      'If you were to recommend AI4Talent to a colleague, what is the biggest "barrier to entry" you think they would face?',
    ),
    scale(
      "Overall, the AI4Talent platform has improved since the first time I used it.",
      AGREE_5,
    ),
  ]),
};

export const SURVEY_TEMPLATES: readonly SurveyTemplate[] = [
  STUDENT_PRE,
  TEACHER_PRE,
  STUDENT_POST,
  TEACHER_POST,
];

export function findSurveyTemplate(key: string): SurveyTemplate | null {
  return SURVEY_TEMPLATES.find((t) => t.key === key) ?? null;
}
