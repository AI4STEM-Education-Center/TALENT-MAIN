import Database from "better-sqlite3";
import { Prisma } from "@prisma/client";
import { ZipArchive } from "archiver";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { resolveDatabaseUrl } from "@/lib/db-url";
import { getS3ObjectAsString } from "@/lib/storage";
import {
  RESEARCH_EXPORT_FIELDS,
  RESEARCH_EXPORT_EXCLUDED_MODELS,
} from "@/lib/research-export-fields";

type Row = Record<string, unknown>;

/** RFC 4180, with spreadsheet formulas escaped without altering numbers. */
export function researchCsvRow(values: unknown[]): string {
  return (
    values
      .map((value) => {
        let text = value == null ? "" : String(value);
        if (typeof value === "string" && /^[\s]*[=+\-@]|^[\t\r\n]/.test(text)) {
          text = `\t${text}`;
        }
        return /[",\r\n\t]/.test(text)
          ? `"${text.replaceAll('"', '""')}"`
          : text;
      })
      .join(",") + "\r\n"
  );
}

// Identifiers only come from generated Prisma metadata and the static allowlist.
function identifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export const researchExportTables = Object.entries(RESEARCH_EXPORT_FIELDS).map(
  ([name, selected]) => {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === name)!;
    const fields = selected.split(" ").map((name) => {
      const field = model.fields.find((f) => f.name === name);
      if (!field || field.kind === "object")
        throw new Error(`Invalid export field: ${model.name}.${name}`);
      return field;
    });
    return {
      model,
      fields,
      filename: `${name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()}.csv`,
      sql: `SELECT ${fields.map((f) => `${identifier(f.dbName ?? f.name)} AS ${identifier(f.name)}`).join(", ")} FROM ${identifier(model.dbName ?? model.name)} ORDER BY ${identifier(fields[0].dbName ?? fields[0].name)}`,
    };
  },
);

function scalar(value: unknown, type: string): unknown {
  if (value == null) return null;
  if (type === "DateTime")
    return new Date(value as string | number).toISOString();
  if (type === "Boolean") return Boolean(value);
  return value;
}

async function* tableCsv(
  db: Database.Database,
  table: (typeof researchExportTables)[number],
) {
  yield "\uFEFF" + researchCsvRow(table.fields.map((f) => f.name));
  for (const row of db.prepare(table.sql).iterate() as Iterable<Row>) {
    yield researchCsvRow(table.fields.map((f) => scalar(row[f.name], f.type)));
  }
  if (table.model.name !== "AssistantMessage") return;

  // Cold transcripts have no original message ids; reconstruct a stable id and
  // sequence, preserving their timestamps and attachment metadata.
  const conversations = db.prepare(
    'SELECT id, bucket, storageKey, messageCount FROM "AssistantConversation" WHERE archivedAt IS NOT NULL ORDER BY id',
  );
  for (const conversation of conversations.iterate() as Iterable<Row>) {
    if (!conversation.bucket || !conversation.storageKey)
      throw new Error("Archived transcript has no storage location.");
    const body = await getS3ObjectAsString(
      String(conversation.bucket),
      String(conversation.storageKey),
    );
    let seq = 0;
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const turn = JSON.parse(line) as Row;
      if (turn.role !== "user" && turn.role !== "assistant") continue;
      const row: Row = {
        id: `${conversation.id}:${seq}`,
        conversationId: conversation.id,
        seq: seq++,
        role: turn.role,
        content: turn.content,
        attachmentIds: JSON.stringify(turn.attachmentIds ?? []),
        attachmentNames: JSON.stringify(turn.attachmentNames ?? []),
        createdAt: turn.createdAt,
      };
      yield researchCsvRow(
        table.fields.map((f) => scalar(row[f.name], f.type)),
      );
    }
    if (seq !== conversation.messageCount)
      throw new Error("Archived transcript is incomplete.");
  }
}

async function* surveyAnswersCsv(db: Database.Database) {
  yield "\uFEFF" +
    researchCsvRow([
      "responseId",
      "formId",
      "userId",
      "questionId",
      "answerJson",
    ]);
  for (const row of db
    .prepare(
      'SELECT id, formId, userId, answers FROM "SurveyResponse" ORDER BY id',
    )
    .iterate() as Iterable<Row>) {
    // Invalid legacy JSON stays intact in survey_response.csv; fail visibly
    // rather than silently dropping answers from the analysis extract.
    const answers = JSON.parse(String(row.answers)) as Record<string, unknown>;
    for (const [questionId, answer] of Object.entries(answers)) {
      yield researchCsvRow([
        row.id,
        row.formId,
        row.userId,
        questionId,
        JSON.stringify(answer),
      ]);
    }
  }
}

async function* surveyQuestionsCsv(db: Database.Database) {
  yield "\uFEFF" +
    researchCsvRow([
      "formId",
      "questionId",
      "position",
      "type",
      "text",
      "questionJson",
    ]);
  for (const row of db
    .prepare('SELECT id, questions FROM "SurveyForm" ORDER BY id')
    .iterate() as Iterable<Row>) {
    const questions = JSON.parse(String(row.questions)) as Row[];
    for (const [position, question] of questions.entries()) {
      yield researchCsvRow([
        row.id,
        question.id,
        position + 1,
        question.type,
        question.text,
        JSON.stringify(question),
      ]);
    }
  }
}

const exportReadme = `TALENT research export (format version 1)

Scope: all retained records in this deployment, without date, class, role, or
consent filtering. This identified administrative extract includes names,
emails, consent decisions, signatures, and free text. Use consent_record.csv
and survey_response.csv to establish the study's eligible cohort.

Each model has one CSV, even when empty. Column names use Prisma's logical
names. IDs are unchanged, so joins across files are possible. data_dictionary.csv
lists types, nullability, descriptions, and declared foreign-key targets.
manifest.json lists row counts, excluded models/fields, and snapshot times.

CSV: UTF-8 with BOM, CRLF records, RFC 4180 quoting. Null is an empty cell;
an empty string is also an empty cell. Dates are ISO 8601 UTC; booleans are
true/false; numeric values retain their units from the schema (Ms = milliseconds).
Free-text cells that could be spreadsheet formulas are prefixed with a tab.
Remove that prefix when importing into an analysis tool. JSON-as-text fields
are preserved; parse them as JSON, not as delimited lists.

Useful joins:
- user.id -> student.userId / teacher.userId / survey_response.userId
- student.id -> class_enrollment.studentId / quiz_attempt.studentId
- quiz_attempt.id -> quiz_answer.quizAttemptId / exam_result.quizAttemptId
- question.id -> quiz_answer.questionId; option.id -> selectedOptionId
- simulation_session.studentId/classId/quizId/attemptId -> corresponding ids
- assistant_conversation.id -> assistant_message.conversationId
- survey_form.id -> survey_response.formId; survey_answers.questionId matches
  the question IDs in survey_form.questions. survey_answers.csv is one row
  per response/question, with multi-select answers preserved as JSON arrays.
  survey_questions.csv provides the question wording, type, order, and full
  definition per form, including section headings.
- consent_record.formVersionId -> consent_form_version.id

exam_result.reviewSnapshot preserves submitted answers and question text after
live content is edited/deleted. quiz_practice_attempt keeps its own questions
and answers; practice is separate from graded quiz attempts. Relation-free
archives can refer to deleted users/classes/content: retain these rows.

assistant_message.csv contains both hot database turns and cold S3 transcripts.
Cold turns reconstruct id as conversationId:seq; the original message id was
not archived. A missing or malformed transcript fails the export. Archived
objects are immutable; their index is read from the same database snapshot.

Only database records and archived chat text are included. Binary uploads,
PDFs, attachment bytes, and simulation HTML objects are referenced by storage
metadata rather than bundled. Already deleted/pruned records and external
resource-monitor spool files cannot be recovered by this export. Credentials,
bearer tokens, email payloads/link variables, and service connection settings
are excluded. A SQLite online backup gives every database CSV one consistent
snapshot; the source database is opened read-only.
`;

/** Stage a complete ZIP on disk, so failures never produce a successful partial
 * download. SQLite and CSVs are streamed with bounded buffers; only one cold
 * conversation is loaded at a time. Clean up after download or cancellation. */
export async function createResearchExport(
  requestedById: string,
  signal?: AbortSignal,
) {
  const directory = await mkdtemp(join(tmpdir(), "talent-research-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  let source: Database.Database | undefined;
  let snapshot: Database.Database | undefined;
  let archive: ZipArchive | undefined;
  let writing: Promise<void> | undefined;
  const inputs: Readable[] = [];
  try {
    signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const url = resolveDatabaseUrl();
    if (!url.startsWith("file:") || url === "file::memory:")
      throw new Error(
        "Research export requires a file-backed SQLite database.",
      );
    source = new Database(url.slice(5), { readonly: true });
    await source.backup(join(directory, "snapshot.db"), {
      progress: () => {
        signal?.throwIfAborted();
        return 128;
      },
    });
    source.close();
    source = undefined;
    const snapshotCompletedAt = new Date().toISOString();
    snapshot = new Database(join(directory, "snapshot.db"), { readonly: true });
    archive = new ZipArchive({ zlib: { level: 6 } });
    const zip = archive;
    function appendCsv(name: string, rows: AsyncIterable<string>) {
      const input = Readable.from(rows, { highWaterMark: 1 });
      inputs.push(input);
      input.on("error", (error) => zip.destroy(error));
      zip.append(input, { name });
    }
    zip.once("close", () => inputs.forEach((input) => input.destroy()));
    const path = join(directory, "research.zip");
    writing = pipeline(zip, createWriteStream(path), { signal });
    // Attach a rejection handler immediately, including while entries are queued.
    void writing.catch(() => {});
    const files = researchExportTables.map((table) => {
      const { count } = snapshot!
        .prepare(
          `SELECT COUNT(*) AS count FROM ${identifier(table.model.dbName ?? table.model.name)}`,
        )
        .get() as { count: number };
      const coldCount =
        table.model.name === "AssistantMessage"
          ? (
              snapshot!
                .prepare(
                  'SELECT COALESCE(SUM(messageCount), 0) AS count FROM "AssistantConversation" WHERE archivedAt IS NOT NULL',
                )
                .get() as { count: number }
            ).count
          : 0;
      appendCsv(table.filename, tableCsv(snapshot!, table));
      return {
        name: table.filename,
        model: table.model.name,
        rows: count + coldCount,
        columns: table.fields.map((f) => f.name),
        excludedFields: table.model.fields
          .filter(
            (f) =>
              f.kind !== "object" &&
              !table.fields.some((selected) => selected.name === f.name),
          )
          .map((f) => f.name),
      };
    });
    appendCsv("survey_answers.csv", surveyAnswersCsv(snapshot));
    appendCsv("survey_questions.csv", surveyQuestionsCsv(snapshot));
    const dictionary = [
      researchCsvRow([
        "file",
        "column",
        "type",
        "nullable",
        "references",
        "description",
      ]),
    ];
    for (const table of researchExportTables) {
      // Prisma 7's runtime DMMF omits isRequired and relationFromFields. Read
      // constraints from the actual snapshot instead of inferring them.
      const tableName = identifier(table.model.dbName ?? table.model.name);
      const columns = snapshot
        .prepare(`PRAGMA table_info(${tableName})`)
        .all() as { name: string; notnull: number }[];
      const foreignKeys = snapshot
        .prepare(`PRAGMA foreign_key_list(${tableName})`)
        .all() as { from: string; table: string; to: string }[];
      for (const field of table.fields) {
        const columnName = field.dbName ?? field.name;
        const foreignKey = foreignKeys.find((key) => key.from === columnName);
        const target = foreignKey
          ? Prisma.dmmf.datamodel.models.find(
              (m) => (m.dbName ?? m.name) === foreignKey.table,
            )
          : undefined;
        const targetField = target?.fields.find(
          (f) => (f.dbName ?? f.name) === foreignKey?.to,
        );
        dictionary.push(
          researchCsvRow([
            table.filename,
            field.name,
            field.type,
            columns.find((column) => column.name === columnName)?.notnull === 0,
            foreignKey
              ? `${target?.name ?? foreignKey.table}.${targetField?.name ?? foreignKey.to}`
              : "",
            field.documentation ?? "",
          ]),
        );
      }
    }
    for (const column of [
      "responseId",
      "formId",
      "userId",
      "questionId",
      "answerJson",
    ]) {
      dictionary.push(
        researchCsvRow([
          "survey_answers.csv",
          column,
          "String",
          column === "userId",
          "",
          column === "answerJson"
            ? "JSON value; array for multi-select answers"
            : "Stable source identifier",
        ]),
      );
    }
    for (const column of [
      "formId",
      "questionId",
      "position",
      "type",
      "text",
      "questionJson",
    ]) {
      dictionary.push(
        researchCsvRow([
          "survey_questions.csv",
          column,
          column === "position" ? "Int" : "String",
          false,
          "",
          column === "questionJson"
            ? "Full question definition as JSON"
            : "Survey question metadata; position is 1-based",
        ]),
      );
    }
    const derivedFiles = [
      {
        name: "survey_answers.csv",
        rows: (
          snapshot
            .prepare(
              'SELECT COUNT(*) AS count FROM "SurveyResponse", json_each("SurveyResponse".answers)',
            )
            .get() as { count: number }
        ).count,
      },
      {
        name: "survey_questions.csv",
        rows: (
          snapshot
            .prepare(
              'SELECT COUNT(*) AS count FROM "SurveyForm", json_each("SurveyForm".questions)',
            )
            .get() as { count: number }
        ).count,
      },
    ];
    archive.append("\uFEFF" + dictionary.join(""), {
      name: "data_dictionary.csv",
    });
    archive.append(exportReadme, { name: "README.txt" });
    archive.append(
      JSON.stringify(
        {
          formatVersion: 1,
          startedAt,
          snapshotCompletedAt,
          requestedById,
          scope: "All retained records; no consent filtering",
          files,
          derivedFiles,
          excludedModels: RESEARCH_EXPORT_EXCLUDED_MODELS,
        },
        null,
        2,
      ),
      { name: "manifest.json" },
    );
    await Promise.all([archive.finalize(), writing]);
    snapshot.close();
    snapshot = undefined;
    await rm(join(directory, "snapshot.db"), { force: true });
    return {
      path,
      cleanup,
      filename: `talent-research-${snapshotCompletedAt.replace(/[:.]/g, "-")}.zip`,
    };
  } catch (error) {
    archive?.destroy();
    inputs.forEach((input) => input.destroy());
    await writing?.catch(() => {});
    await Promise.allSettled(
      inputs.map((input) => finished(input, { cleanup: true })),
    );
    source?.close();
    snapshot?.close();
    await cleanup();
    throw error;
  }
}
