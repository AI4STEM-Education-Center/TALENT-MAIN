import type { ConsentRole } from "@/lib/consent";

/**
 * The IRB-approved consent forms, transcribed to web-renderable HTML from the
 * source PDFs for PROJECT00015294, approved 9/22/2026 ("PROJECT00015294
 * Student Consent Form.pdf" and "PROJECT00015294 Instructor Consent
 * Form.pdf"). This module is the single source for that text: both
 * prisma/seed-consent.ts and the admin "publish a version" screen read it, so
 * a deployment can never end up with two different transcriptions in play.
 *
 * Ground rules for editing:
 *  - The body is the LEGAL text and must stay a faithful transcription of the
 *    approved PDF. Anything that describes how this website behaves (e.g. what
 *    declining does to an instructor's access) belongs in the surrounding UI,
 *    not in here.
 *  - Wording changes are a new IRB revision: bump OFFICIAL_CONSENT_VERSION and
 *    publish through /admin/consent/forms, which appends a new version rather
 *    than rewriting what past signatures agreed to. Never edit an already
 *    published version's text in the database.
 *  - Only tags on the sanitizeConsentHtml allowlist survive rendering
 *    (src/lib/consent-html.ts) — headings, paragraphs, lists, and inline
 *    emphasis. Anything else is stripped before it reaches a signer.
 *
 * Paper-form fields deliberately not reproduced here: the signature, initials,
 * and date lines, which the web form captures as real inputs (see
 * src/components/consent/ConsentForm.tsx) and stamps server-side.
 */

/** Bump when the approved text changes; used as the published version label. */
export const OFFICIAL_CONSENT_VERSION = "2026-09-22";

const STUDENT_FORM_HTML = `
<h2>University of Georgia Student Consent Form</h2>
<h3>Teacher-Involved Adaptive Learning with Explainable Generative AI</h3>
<p>You are being asked to take part in a research study. The information in this form will help you decide if you want to be in the study. Please ask the researcher below if there is anything that is not clear or if you need more information.</p>
<p><strong>Principal Investigator:</strong> Dr. Xiaoming Zhai, Dept. of Science Education and AI, xiaoming.zhai@uga.edu</p>

<h4>Study Purpose</h4>
<p>We are doing this research study to learn more about a new learning platform, AI4Talent, designed to support students in introductory physics courses. This platform uses artificial intelligence (AI) to help create practice questions, suggest learning activities, and provide interactive support. The goal of this study is to understand whether this AI-supported learning system improves student learning and engagement, and how students and instructors experience using it.</p>

<h4>Study Participation</h4>
<p>You are being invited to be in this research study because you are enrolled in an introductory physics course at the University of Georgia that is using the AI4Talent platform. During the semester, you will use the AITalent platform to support your learning in up to 15 class sessions for approximately 30 minutes per session.</p>
<p>If you agree to participate in this study, the research team may collect:</p>
<ul>
<li>Survey responses about your experience, attitudes, and perceptions with using the platform (2 surveys, 20-30 minutes each)</li>
<li>Responses from interviews about your experience using the platform (about 1 hour). These interviews will be conducted via Zoom and you can approve to have the interviews recorded with video, with audio-only, or no recording.</li>
<li>System usage data (such as which materials you accessed or how you interacted with the AI tool)</li>
<li>Your scores on course assessments (such as quizzes, exams, or assignments)</li>
<li>Pre-test and post-test results to measure learning gains</li>
</ul>
<p>The researchers will use this information to evaluate how well the system supports learning and how usable it is for students and instructors.</p>

<h4>Participation is voluntary</h4>
<p>Participation is voluntary. You can refuse to take part or stop at any time without penalty. <strong>Your participation will not be known to your course instructor while you are enrolled in the course.</strong> Your decision to participate in the study will have no impact on your grades in this course. <strong>You are expected to complete all course assignments regardless of your participation in this study.</strong></p>
<p>If you decide to stop or withdraw from the study or the investigator terminates your participation, the information/data collected from or about you up to the point of your withdrawal will be kept as part of the study and may continue to be analyzed.</p>

<h4>Incentives for participation</h4>
<p>Instructors may provide a small amount of class credit or extra-credit for students who use the AI4Talent platform, regardless of whether or not they consent to participate in the study. In addition, if you choose not to use the AI4Talent platform at all, you can still have the opportunity to receive extra course credit by completing the quiz questions and learning materials provided in digital form (e.g., MS Word, PowerPoint).</p>

<h4>Risks</h4>
<p>This study involves minimal risk. Possible risks may include: (1) mild frustration or discomfort when using new technology; (2) fatigue from completing surveys or assessments; (3) a small risk of loss of confidentiality if research data were improperly accessed. To reduce these risks, instructors will guide use of the system, participation in surveys or interviews is voluntary, and data will be securely stored and protected. As members of the research team regularly teach courses in the department, there is a possibility that a member of the research team could be an instructor of one of your future courses.</p>

<h4>Benefits</h4>
<p>You may or may not receive direct benefits from participating. Possible benefits include: (1) access to personalized learning materials; (2) additional practice opportunities and feedback; and (3) improved understanding of physics concepts. The broader benefit of this research is to help improve AI-supported educational tools and better understand how technology can support student learning in the future.</p>

<h4>Privacy</h4>
<p>We will take steps to protect your privacy, but there is a small risk that your information could be accidentally disclosed to people not connected to the research. To reduce this risk, we will remove your name and any university ID numbers from your grades and exam responses as soon as practical. Your data will be assigned a 4-digit number for the purposes of linking exam responses and your grades (e.g., S####). The Principal Investigator will maintain a separate file that contains your name and 4-digit ID number in the event that the data needs to be relinked. Only the Principal Investigator will have access to this file and it will remain on a separate hard drive in a locked room.</p>
<p>This research also involves the transmission of data over the Internet. Every reasonable effort has been taken to ensure the effective use of available technology; however, confidentiality during online communication cannot be guaranteed. Transcribed text from interviews may also be processed through the OpenAI API, an AI-based cloud service, for research analysis purposes. Both Amazon Web Services (AWS) and OpenAI operate under data processing agreements that restrict the use of uploaded data; uploaded content is not used to train their AI models. Data is encrypted in transit and at rest, and access is restricted to authorized members of the research team. All data is stored on servers located in the United States. The research team removes direct identifiers (e.g., names) from transcripts as soon as practicable after transcription. Audio and video recordings of interviews will be permanently deleted from all recording devices and cloud storage within two years after transcription has been completed and verified; only the de-identified transcripts will be retained after that point. The research team removes direct identifiers (e.g., names) from transcripts as soon as practicable after transcription. There is an inherent risk in sharing data with third-party cloud services; the research team mitigates this risk by using secure, authenticated accounts, limiting the data uploaded, and de-identifying transcripts promptly. We will keep data in secure offices or data centers and will destroy data three years after the final research report is published.</p>
<p>The information collected in this study may be used in future studies without obtaining additional consent at the Principal Investigator's discretion. In this case, only the data with your identifying information removed would be shared, and the linking file will not be shared except as required by law or by the university. Any such studies would require the University of Georgia's Institutional Review Board's approval as applicable.</p>

<h4>Participant relationships with researchers &amp; conflicts of interest</h4>
<p>Your course instructors will work with the research team to create appropriate exam questions, review learning materials, and discuss the findings of this study with the research team. Your course instructors may also have access to your data to aid in the analysis or knowledge of your participation, but not before your final grades for this course have been submitted. Your decision to take part in this study will not affect your course grade or class standing.</p>

<h4>Sponsored research</h4>
<p>This research is funded by the National Science Foundation, grant number RITEL 2507128. To comply with sponsor requirements, the sponsor reserves the right to inspect research records, including data.</p>

<h4>Contact information</h4>
<p>Please feel free to ask questions about this research at any time. You can contact the Principal Investigator, Dr. Xiaoming Zhai at xiaoming.zhai@uga.edu. If you have any complaints or questions about your rights as a research volunteer, contact the IRB at 706-542-3199 or by email at IRB@uga.edu.</p>
<p>Please check the appropriate box for this study and fill out the requested information. For the purposes of this form, typing your name is equivalent to your legal signature.</p>
<ul>
<li>Yes, I agree to participate in this study. I am at least 18 years old and have legal authority to consent to participate in this study.</li>
<li>No, I do not agree to participate in this study, or I am not at least 18 years old.</li>
</ul>

<h4>Interview Recording (optional)</h4>
<p>If you are invited to take part in an interview, we would like to record the interview with audio or video so that it can be accurately transcribed. Participating in the interview is optional. Please check one box below.</p>
<ul>
<li>I agree to have my interview recorded with video and audio.</li>
<li>I agree to have my interview recorded with audio only.</li>
<li>I agree to have my interview transcribed, but do not consent to audio or video recording.</li>
<li>I do not want to participate in the interview.</li>
</ul>
<p>For the purposes of this form, typing your name is equivalent to your legal signature. A copy of this consent form will be emailed to you for your records.</p>
`.trim();

const TEACHER_FORM_HTML = `
<h2>University of Georgia Instructor Consent Form</h2>
<h3>Teacher-Involved Adaptive Learning with Explainable Generative AI</h3>
<p>You are being asked to take part in a research study. The information in this form will help you decide if you want to be in the study. Please ask the researcher below if there is anything that is not clear or if you need more information.</p>
<p><strong>Principal Investigator:</strong> Dr. Xiaoming Zhai, Dept. of Science Education and AI, xiaoming.zhai@uga.edu</p>

<h4>Study Purpose</h4>
<p>We are doing this research study to learn more about a new learning platform, AI4Talent, designed to support students in introductory physics courses. This platform uses artificial intelligence (AI) to help create practice questions, suggest learning activities, and provide interactive support. The goal of this study is to understand whether this AI-supported learning platform improves student learning and engagement, and how students and instructors experience using it.</p>

<h4>Study Participation</h4>
<p>You are being invited to be in this research study because you teach (or plan to teach) an introductory physics course that may participate in piloting this platform. Depending on the study phase, your participation may take place over one or two academic semesters. Some instructors may participate in a second phase in a later year. If your course uses AI4Talent, you may use the platform as part of your regular teaching in up to 15 class sessions per semester, for approximately 30 minutes per session. In a comparison section, you will use standard instructional methods instead. You may also attend one platform orientation or training session lasting about one hour and up to two co-design discussions lasting about one hour each. In each academic year of participation, research-specific activities may include up to five hours reviewing and testing study materials and the platform, two surveys lasting about 30 minutes each, up to two interviews lasting about one hour each, and up to two hours assisting the research team with data collection. If your interview takes place on Zoom, you may choose audio and video recording, audio-only recording, or no recording. If you decline recording, you may still participate in the interview; the researcher will take written notes instead. If you complete all listed activities in one study phase, your total time commitment is estimated at up to approximately 20.5 hours over one semester. This estimate includes time spent using AI4Talent during regular teaching. If you agree to participate, you may:</p>
<ul>
<li>Use AI4Talent in your course</li>
<li>Review and edit AI-generated assessment materials</li>
<li>Use recommendation tools to guide student learning pathways</li>
<li>Interact with the platform's conversational module</li>
<li>Participate in co-design discussions to refine system features</li>
<li>Complete surveys about your experience using the platform</li>
<li>Participate in a semi-structured interview about usability, instructional impact, and engagement. Intervews will be conducted via Zoom and you can approve to have the interviews recorded with video, with audio-only, or no recording.</li>
</ul>
<p>Some course sections may serve as comparison (control) sections using standard instructional methods.</p>
<p>If you participate, the research team may collect:</p>
<ul>
<li>Survey responses about your experience, attitudes, and perceptions</li>
<li>Interview responses about system usability and instructional impact</li>
<li>Information about how you use and modify AI-generated materials</li>
<li>Course-level student outcome data (e.g., assessment results, learning gains)</li>
<li>System usage data related to instructional implementation</li>
</ul>
<p>The researchers will use this information to evaluate how well the system supports learning and how usable it is for students and instructors.</p>

<h4>Participation is voluntary</h4>
<p>Participation is voluntary. You may decline to participate or withdraw at any time without penalty or impact on your employment or professional standing.</p>
<p>If you decide to stop or withdraw from the study or the investigator terminates your participation, the information/data collected from or about you up to the point of your withdrawal will be kept as part of the study and may continue to be analyzed.</p>

<h4>Incentives for participation</h4>
<p>Instructors participating in this study will receive compensation at $100/hour for their time completing the feedback surveys and interviews and assisting with data collection. Instructor compensation covers only research-specific activities—completing the usability, feasibility, and personalized-instruction surveys; participating in the corresponding interviews; and assisting the research team with data collection (e.g., scheduling student focus groups/interviews and administering the study introduction). Implementation of AI4Talent as part of regular teaching and any orientation/training on the platform are considered normal instructional activities and are not compensated. Each research activity has a fixed expected duration, and payment is computed from those durations at $100/hour. Expected participation per instructor per academic year includes: review and test materials and platform, up to 5 hours; surveys, 2 × 30 minutes (1 hour); interviews, 2 X 1 hour (2 hours); and data-collection support, up to 2 hours—a total of up to 10 hours, or a maximum of $1,000 per instructor per year. The Phase 1 usability and Phase 2 feasibility studies involve different groups of instructors. Some Phase 3 implementation instructors may have participated in an earlier phase; in that case an instructor could participate in at most two phases, so the maximum total any individual instructor may receive over the course of the study is $2,000.</p>
<p>Payment for participating in this study will be made using ClinCard, a pre-paid VISA that works like a pre-paid debit card. We will give you the card and money will be added to your card based on the study's payment schedule. You may use this card online or at any store that accepts VISA. We will provide you with an information sheet about the ways you can use the card, some of which may involve fees that will reduce the amount of money on the card. The card is run by Greenphire, an independent company specializing in payments for research studies and clinical trials. Be sure to read this information, including the cardholder agreement from Greenphire.</p>
<p>To issue your card, we need to give Greenphire some of your personal information (or your child's). If you do not wish to provide this information, you can still take part in the study, but you will not be paid. Banks and other financial institutions can access this information if they need to verify your identity when you use your card. Greenphire will be given your name, address, and date of birth. They will use this information only as part of the payment system, and it will not be given or sold to any other company. If a single payment is over $100 or we anticipate that you will earn more than $600 in one year from participating in UGA research projects, you will need to complete a tax form and provide your social security number. If you earn more than $600 from UGA research in one year, UGA must report this to the IRS and you will receive a 1099 form. This may affect your taxes.</p>

<h4>Risks</h4>
<p>This study involves minimal risk. Possible risks may include: (1) time required to learn and implement a new instructional technology; (2) mild frustration or workload changes associated with system use; (3) discomfort in providing feedback during interviews; and (4) a small risk of loss of confidentiality if research data were improperly accessed. To reduce these risks, participation in surveys and interviews is voluntary, you may skip any question you prefer not to answer, and all research data will be securely stored.</p>

<h4>Benefits</h4>
<p>You may or may not receive direct benefits from participating. Possible benefits may include: (1) access to AI-assisted tools for generating assessments and recommendations; (2) increased insight into student learning patterns; and (3) opportunities to co-design and shape emerging AI tools for education. The broader benefit of this research is to improve adaptive learning technologies and contribute to research in AI in education and human-centered computing.</p>

<h4>Privacy</h4>
<p>We will take steps to protect your privacy, but there is a small risk that your information could be accidentally disclosed to people not connected to the research. Identifiable information will be removed or coded whenever possible. Findings will be reported in summary form so that individual instructors cannot be identified in publications or presentations</p>
<p>This research also involves the transmission of data over the Internet. Every reasonable effort has been taken to ensure the effective use of available technology; however, confidentiality during online communication cannot be guaranteed. Transcribed text from interviews may also be processed through the OpenAI API, an AI-based cloud service, for research analysis purposes. Both Amazon Web Services (AWS) and OpenAI operate under data processing agreements that restrict the use of uploaded data; uploaded content is not used to train their AI models. Data is encrypted in transit and at rest, and access is restricted to authorized members of the research team. All data is stored on servers located in the United States. Audio and video recordings of interviews will be permanently deleted from all recording devices and cloud storage within two years after transcription has been completed and verified; only the de-identified transcripts will be retained after that point. The research team removes direct identifiers (e.g., names) from transcripts as soon as practicable after transcription. There is an inherent risk in sharing data with third-party cloud services; the research team mitigates this risk by using secure, authenticated accounts, limiting the data uploaded, and de-identifying transcripts promptly. We will keep data in secure offices or data centers and will destroy data three years after the final research report is published.</p>
<p>The information collected in this study may be used in future studies without obtaining additional consent at the Principal Investigator's discretion. In this case, only the data with your identifying information removed would be shared, and the linking file will not be shared except as required by law or by the university. Any such studies would require the University of Georgia's Institutional Review Board's approval as applicable.</p>

<h4>Sponsored research</h4>
<p>This research is funded by the National Science Foundation, grant number RITEL 2507128. To comply with sponsor requirements, the sponsor reserves the right to inspect research records, including data.</p>

<h4>Contact information</h4>
<p>Please feel free to ask questions about this research at any time. You can contact the Principal Investigator, Dr. Xiaoming Zhai at xiaoming.zhai@uga.edu. If you have any complaints or questions about your rights as a research volunteer, contact the IRB at 706-542-3199 or by email at IRB@uga.edu.</p>

<h4>Interview Recording (optional)</h4>
<p>If you are invited to take part in an interview, we would like to record the interview with audio or video so that it can be accurately transcribed. Participating in the interview is optional. Please check one box below.</p>
<ul>
<li>I agree to have my interview recorded with video and audio.</li>
<li>I agree to have my interview recorded with audio only.</li>
<li>I agree to have my interview transcribed, but do not consent to audio or video recording.</li>
<li>I do not want to participate in the interview.</li>
</ul>
<p>If you agree to participate in this research study, please sign below. For the purposes of this form, typing your name is equivalent to your legal signature. A copy to this consent form will be emailed to you for your records.</p>
`.trim();

export interface OfficialConsentForm {
  role: ConsentRole;
  version: string;
  title: string;
  bodyHtml: string;
}

export const OFFICIAL_CONSENT_FORMS: Record<ConsentRole, OfficialConsentForm> =
  {
    STUDENT: {
      role: "STUDENT",
      version: OFFICIAL_CONSENT_VERSION,
      title:
        "Teacher-Involved Adaptive Learning with Explainable Generative AI — Student Consent Form",
      bodyHtml: STUDENT_FORM_HTML,
    },
    TEACHER: {
      role: "TEACHER",
      version: OFFICIAL_CONSENT_VERSION,
      title:
        "Teacher-Involved Adaptive Learning with Explainable Generative AI — Instructor Consent Form",
      bodyHtml: TEACHER_FORM_HTML,
    },
  };
