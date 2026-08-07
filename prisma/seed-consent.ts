import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { resolveDatabaseUrl } from "../src/lib/db-url";

// Idempotent, additive-only seed for the IRB consent forms — mirrors
// seed-prebuilt.ts's "skip if it already exists" pattern rather than
// seed.ts's destructive wipe, since this must be safe to run against a live
// production database. Publishing a genuinely new form revision later should
// go through the admin UI (which creates a new version + deactivates the old
// one), not by re-running this script with edited text.

const adapter = new PrismaBetterSqlite3({ url: resolveDatabaseUrl() });
const prisma = new PrismaClient({ adapter });

const CONSENT_VERSION = "2026-08-06";

const STUDENT_FORM_HTML = `
<h2>University of Georgia Student Consent Form</h2>
<h3>Teacher-Involved Adaptive Learning with Explainable Generative AI</h3>
<p>You are being asked to take part in a research study. The information on this form will help you decide if you want to be in the study. Please contact the researcher below if there is anything that is not clear or if you need more information.</p>
<p><strong>Principal Investigator:</strong> Dr. Xiaoming Zhai, Dept. of Science Education and AI, xiaoming.zhai@uga.edu</p>

<h4>Study Purpose</h4>
<p>We are doing this research study to learn more about a new learning platform, AI4Talent, designed to support students in introductory physics courses. This platform uses artificial intelligence (AI) to help create practice questions, suggest learning activities, and provide interactive support. The goal of this study is to understand whether this AI-supported learning system improves student learning and engagement, and how students and instructors experience using it.</p>

<h4>Study Participation</h4>
<p>You are being invited to be in this research study because you are enrolled in an introductory physics course at the University of Georgia that is using the AI4Talent platform.</p>
<p>If you agree to participate in this study, the research team may collect:</p>
<ul>
<li>Your scores on course assessments (such as quizzes, exams, or assignments)</li>
<li>Pre-test and post-test results to measure learning gains</li>
<li>Your responses to surveys and interviews about your experience using the system</li>
<li>System usage data (such as which materials you accessed or how you interacted with the AI tool)</li>
</ul>
<p>If you choose to participate, interviews about your experience using the system may also be conducted. The interviews will be audio recorded and transcribed only with your permission. Any notes, recordings, or transcriptions will be kept secure (see Privacy below). If you would like to consent to having an interview recorded, you will be asked to provide your initials below.</p>
<p>The researchers will use this information to evaluate how well the system supports learning and how usable it is for students and instructors.</p>

<h4>Participation is voluntary</h4>
<p>Participation is voluntary. You can refuse to take part or stop at any time without penalty. <strong>Your participation will not be known to your course instructor while you are enrolled in the course.</strong> Your decision to participate in the study will have no impact on your grades in this course. <strong>You are expected to complete all course assignments regardless of your participation in this study.</strong></p>
<p>If you decide to stop or withdraw from the study, or the investigator terminates your participation, the information/data collected from or about you up to the point of your withdrawal will be kept as part of the study and may continue to be analyzed.</p>

<h4>Incentives for participation</h4>
<p>Instructors may provide a small amount of class credit or extra-credit for students who use the AI4Talent platform, regardless of whether or not they consent to participate in this study.</p>

<h4>Risks</h4>
<p>This study involves minimal risk. Possible risks may include: (1) mild frustration or discomfort when using new technology; (2) fatigue from completing surveys or assessments; (3) a small risk of loss of confidentiality if research data were improperly accessed. To reduce these risks, instructors will guide use of the system, participation in surveys or interviews is voluntary, and data will be securely stored and protected. As members of the research team regularly teach courses in the department, there is a possibility that a member of the research team could be an instructor of one of your future courses.</p>

<h4>Benefits</h4>
<p>You may or may not receive direct benefits from participating. Possible benefits include: (1) access to personalized learning materials; (2) additional practice opportunities and feedback; and (3) improved understanding of physics concepts. The broader benefit of this research is to help improve AI-supported educational tools and better understand how technology can support student learning in the future.</p>

<h4>Privacy</h4>
<p>We will take steps to protect your privacy, but there is a small risk that your information could be accidentally disclosed to people not connected to the research. To reduce this risk, we will remove your name and any university ID numbers from your grades and exam responses as soon as practical. Your data will be assigned a 4-digit number for the purposes of linking exam responses and your grades (e.g., S####). The Principal Investigator will maintain a separate file that contains your name and 4-digit ID number in the event that the data needs to be relinked. Only the Principal Investigator will have access to this file, and it will remain on a separate hard drive in a locked room.</p>
<p>This research also involves the transmission of data over the Internet. Every reasonable effort has been taken to ensure the effective use of available technology; however, confidentiality during online communication cannot be guaranteed. Audio recordings of interviews may also be collected. These recordings contain identifiable information (e.g., participants' voices). Audio recordings are uploaded to Amazon Web Services (AWS), a cloud-based platform, for automated transcription using AI-powered speech-to-text services. Transcribed text may also be processed through the OpenAI API, an AI-based cloud service, for research analysis purposes. Both AWS and OpenAI operate under data processing agreements that restrict the use of uploaded data; uploaded content is not used to train their AI models. Data is encrypted in transit and at rest, and access is restricted to authorized members of the research team. All data is stored on servers located in the United States. Audio recordings are deleted from cloud services within 90 days of transcription; de-identified transcripts are retained on secure university systems for the duration of the study. The research team removes direct identifiers (e.g., names) from transcripts as soon as practicable after transcription. There is an inherent risk in sharing data with third-party cloud services; the research team mitigates this risk by using secure, authenticated accounts, limiting the data uploaded, and de-identifying transcripts promptly. We will keep data in secure offices or data centers and will destroy data three years after the final research report is published.</p>
<p>The information collected in this study may be used in future studies without obtaining additional consent at the Principal Investigator's discretion. In this case, only the data with your identifying information removed would be shared, and the linking file will not be shared except as required by law or by the university. Any such studies would require the University of Georgia's Institutional Review Board's approval as applicable.</p>

<h4>Participant relationships with researchers &amp; conflicts of interest</h4>
<p>Your course instructors will work with the research team to create appropriate exam questions, review learning materials, and discuss the findings of this study with the research team. Your course instructors may also have access to your data to aid in the analysis or knowledge of your participation, but not before your final grades for this course have been submitted. Your decision to take part in this study will not affect your course grade or class standing.</p>

<h4>Sponsored research</h4>
<p>This research is funded by the National Science Foundation, grant number RITEL 2507128. To comply with sponsor requirements, the sponsor reserves the right to inspect research records, including data.</p>

<h4>Contact information</h4>
<p>Please feel free to ask questions about this research at any time. You can contact the Principal Investigator, Dr. Xiaoming Zhai, at xiaoming.zhai@uga.edu. If you have any complaints or questions about your rights as a research volunteer, contact the IRB at 706-542-3199 or by email at IRB@uga.edu.</p>
<p>By choosing "Yes" below, you certify that you are at least 18 years old and have the legal authority to consent to participate in this study. By choosing "No," you indicate you do not agree to participate, or that you are not at least 18 years old. For the purposes of this form, typing your name and submitting it below is equivalent to your legal signature. A copy of this consent form will be emailed to you for your records.</p>
`.trim();

const TEACHER_FORM_HTML = `
<h2>University of Georgia Instructor Consent Form</h2>
<h3>Teacher-Involved Adaptive Learning with Explainable Generative AI</h3>
<p>You are being asked to take part in a research study. The information on this form will help you decide if you want to be in the study. Please contact the researcher below if there is anything that is not clear or if you need more information.</p>
<p><strong>Principal Investigator:</strong> Dr. Xiaoming Zhai, Dept. of Science Education and AI, xiaoming.zhai@uga.edu</p>

<h4>Study Purpose</h4>
<p>We are doing this research study to learn more about a new learning platform, AI4Talent, designed to support students in introductory physics courses. This platform uses artificial intelligence (AI) to help create practice questions, suggest learning activities, and provide interactive support. The goal of this study is to understand whether this AI-supported learning platform improves student learning and engagement, and how students and instructors experience using it.</p>

<h4>Study Participation</h4>
<p>You are being invited to be in this research study because you teach (or plan to teach) an introductory physics course that may participate in piloting this platform. If you agree to participate, you may:</p>
<ul>
<li>Use AI4Talent in your course</li>
<li>Review and edit AI-generated assessment materials</li>
<li>Use recommendation tools to guide student learning pathways</li>
<li>Interact with the platform's conversational module</li>
<li>Participate in co-design discussions to refine system features</li>
<li>Complete surveys about your experience using the platform</li>
<li>Participate in a semi-structured interview about usability, instructional impact, and engagement</li>
</ul>
<p>Some course sections may serve as comparison (control) sections using standard instructional methods.</p>
<p>If you participate, the research team may collect: survey responses about your experience, attitudes, and perceptions; interview responses about system usability and instructional impact; information about how you use and modify AI-generated materials; course-level student outcome data (e.g., assessment results, learning gains); and system usage data related to instructional implementation.</p>
<p>The interview will be audio recorded and transcribed only with your permission. Any notes, recordings, or transcriptions will be kept secure (see Privacy below). If you would like to consent to having an interview recorded, you will be asked to provide your initials below.</p>
<p>The researchers will use this information to evaluate how well the system supports learning and how usable it is for students and instructors.</p>

<h4>Participation is voluntary</h4>
<p>Participation is voluntary. You may decline to participate or withdraw at any time without penalty or impact on your employment or professional standing. Declining this consent means your course will not be provisioned with the AI4Talent pilot platform; it does not affect your job, standing, or any other university relationship.</p>
<p>If you decide to stop or withdraw from the study, or the investigator terminates your participation, the information/data collected from or about you up to the point of your withdrawal will be kept as part of the study and may continue to be analyzed.</p>

<h4>Incentives for participation</h4>
<p>Instructors participating in this study will receive compensation at $150/hour for their time completing the feedback surveys and interviews.</p>

<h4>Risks</h4>
<p>This study involves minimal risk. Possible risks may include: (1) time required to learn and implement a new instructional technology; (2) mild frustration or workload changes associated with system use; (3) discomfort in providing feedback during interviews; and (4) a small risk of loss of confidentiality if research data were improperly accessed. To reduce these risks, participation in surveys and interviews is voluntary, you may skip any question you prefer not to answer, and all research data will be securely stored.</p>

<h4>Benefits</h4>
<p>You may or may not receive direct benefits from participating. Possible benefits may include: (1) access to AI-assisted tools for generating assessments and recommendations; (2) increased insight into student learning patterns; and (3) opportunities to co-design and shape emerging AI tools for education. The broader benefit of this research is to improve adaptive learning technologies and contribute to research in AI in education and human-centered computing.</p>

<h4>Privacy</h4>
<p>We will take steps to protect your privacy, but there is a small risk that your information could be accidentally disclosed to people not connected to the research. Identifiable information will be removed or coded whenever possible. Findings will be reported in summary form so that individual instructors cannot be identified in publications or presentations.</p>
<p>This research also involves the transmission of data over the Internet. Every reasonable effort has been taken to ensure the effective use of available technology; however, confidentiality during online communication cannot be guaranteed. Audio recordings of interviews may also be collected. These recordings contain identifiable information (e.g., participants' voices). Audio recordings are uploaded to Amazon Web Services (AWS), a cloud-based platform, for automated transcription using AI-powered speech-to-text services. Transcribed text may also be processed through the OpenAI API, an AI-based cloud service, for research analysis purposes. Both AWS and OpenAI operate under data processing agreements that restrict the use of uploaded data; uploaded content is not used to train their AI models. Data is encrypted in transit and at rest, and access is restricted to authorized members of the research team. All data is stored on servers located in the United States. Audio recordings are deleted from cloud services within 90 days of transcription; de-identified transcripts are retained on secure university systems for the duration of the study. The research team removes direct identifiers (e.g., names) from transcripts as soon as practicable after transcription. There is an inherent risk in sharing data with third-party cloud services; the research team mitigates this risk by using secure, authenticated accounts, limiting the data uploaded, and de-identifying transcripts promptly. We will keep data in secure offices or data centers and will destroy data three years after the final research report is published.</p>
<p>The information collected in this study may be used in future studies without obtaining additional consent at the Principal Investigator's discretion. In this case, only the data with your identifying information removed would be shared, and the linking file will not be shared except as required by law or by the university. Any such studies would require the University of Georgia's Institutional Review Board's approval as applicable.</p>

<h4>Sponsored research</h4>
<p>This research is funded by the National Science Foundation, grant number RITEL 2507128. To comply with sponsor requirements, the sponsor reserves the right to inspect research records, including data.</p>

<h4>Contact information</h4>
<p>Please feel free to ask questions about this research at any time. You can contact the Principal Investigator, Dr. Xiaoming Zhai, at xiaoming.zhai@uga.edu. If you have any complaints or questions about your rights as a research volunteer, contact the IRB at 706-542-3199 or by email at IRB@uga.edu.</p>
<p>For the purposes of this form, typing your name and submitting it below is equivalent to your legal signature. A copy of this consent form will be emailed to you for your records.</p>
`.trim();

async function upsertVersion(role: "STUDENT" | "TEACHER", title: string, bodyHtml: string) {
  const existing = await prisma.consentFormVersion.findUnique({
    where: { role_version: { role, version: CONSENT_VERSION } },
  });
  if (existing) {
    console.log(`  ${role} form ${CONSENT_VERSION} already exists — skipping.`);
    return;
  }

  await prisma.$transaction([
    prisma.consentFormVersion.updateMany({ where: { role, isActive: true }, data: { isActive: false } }),
    prisma.consentFormVersion.create({
      data: { role, version: CONSENT_VERSION, title, bodyHtml, isActive: true },
    }),
  ]);
  console.log(`  Created and activated ${role} form ${CONSENT_VERSION}.`);
}

async function main() {
  console.log("Seeding IRB consent form versions...");
  await upsertVersion(
    "STUDENT",
    "Teacher-Involved Adaptive Learning with Explainable Generative AI — Student Consent Form",
    STUDENT_FORM_HTML
  );
  await upsertVersion(
    "TEACHER",
    "Teacher-Involved Adaptive Learning with Explainable Generative AI — Instructor Consent Form",
    TEACHER_FORM_HTML
  );

  const existingSettings = await prisma.consentExportSettings.findUnique({ where: { id: "singleton" } });
  if (!existingSettings) {
    await prisma.consentExportSettings.create({ data: { id: "singleton" } });
    console.log("  Created default ConsentExportSettings row.");
  } else {
    console.log("  ConsentExportSettings row already exists — skipping.");
  }

  console.log("Consent seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
