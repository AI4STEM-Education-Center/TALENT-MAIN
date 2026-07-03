#!/usr/bin/env node
/*
 * ONE-TIME CUTOVER MIGRATION — safe to delete once every environment has run it.
 *
 * Honker (the SQLite job queue) used to open the SAME file Prisma manages, so its
 * `_honker_*` tables lived inside the app database. `prisma db push` sees those
 * tables as unknown and wants to DROP them; in production (where the entrypoint
 * withholds --accept-data-loss) that destructive diff makes the whole push refuse,
 * so additive schema changes never apply. See src/lib/queue.ts (resolveQueueDbPath).
 *
 * The fix points Honker at a sibling `<name>.queue.db`. This script moves any
 * pre-existing `_honker_*` tables OUT of the app DB into that sibling file — schema,
 * rows, and indexes — WITHOUT dropping any queued jobs, then removes them from the
 * app DB so the next `db push` diff is purely additive.
 *
 * Idempotent: it no-ops when the app DB has no `_honker_*` tables (fresh install or
 * already migrated). Runs before `prisma db push` in docker-entrypoint.sh.
 */
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

// Mirror resolveDatabaseUrl (src/lib/db-url.ts): re-anchor a relative sqlite
// `file:` path under <cwd>/prisma, matching how Prisma opens the DB.
function resolveMainDbPath() {
  const raw = process.env.DATABASE_URL;
  if (!raw || !raw.startsWith("file:")) return null; // non-sqlite: nothing to do
  const filePath = raw.slice("file:".length).split("?")[0];
  if (filePath === ":memory:") return null;
  return path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), "prisma", filePath);
}

// Mirror deriveQueueDbPath (src/lib/queue.ts): foo.db -> foo.queue.db.
function deriveQueueDbPath(mainPath) {
  return mainPath.endsWith(".db")
    ? `${mainPath.slice(0, -".db".length)}.queue.db`
    : `${mainPath}.queue.db`;
}

const TAG = "[honker-migrate]";

function main() {
  const mainPath = resolveMainDbPath();
  if (!mainPath) {
    console.log(`${TAG} non-file datasource; nothing to do`);
    return;
  }
  if (!fs.existsSync(mainPath)) {
    console.log(`${TAG} app DB not created yet; nothing to migrate`);
    return;
  }

  const queuePath = deriveQueueDbPath(mainPath);
  const db = new Database(mainPath);
  try {
    const objects = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master " +
          "WHERE name LIKE '\\_honker\\_%' ESCAPE '\\' AND sql IS NOT NULL",
      )
      .all();
    const tables = objects.filter((o) => o.type === "table");
    const indexes = objects.filter((o) => o.type === "index");

    if (tables.length === 0) {
      console.log(`${TAG} no _honker_ tables in app DB; already migrated or fresh`);
      return;
    }

    console.log(
      `${TAG} moving ${tables.length} Honker table(s) from ${mainPath} -> ${queuePath}`,
    );
    db.exec(`ATTACH '${queuePath.replace(/'/g, "''")}' AS queuedb`);

    const migrate = db.transaction(() => {
      for (const t of tables) {
        // Rebuild the table in the queue DB with the exact original DDL, then
        // copy every row (SELECT * preserves column order and rowid aliases, so
        // job ids and ordering survive). DROP-first keeps a retried run clean.
        db.exec(`DROP TABLE IF EXISTS queuedb."${t.name}"`);
        db.exec(injectSchema(t.sql, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i));
        const res = db
          .prepare(`INSERT INTO queuedb."${t.name}" SELECT * FROM main."${t.name}"`)
          .run();
        console.log(`${TAG}   ${t.name}: ${res.changes} row(s)`);
      }
      for (const ix of indexes) {
        db.exec(
          injectSchema(ix.sql, /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?/i),
        );
      }
      for (const t of tables) db.exec(`DROP TABLE main."${t.name}"`);
    });
    migrate();

    db.exec("DETACH queuedb");
    console.log(`${TAG} done — queue tables now live in ${queuePath}`);
  } finally {
    db.close();
  }
}

/** Insert `queuedb.` right before the object name in a CREATE statement. */
function injectSchema(sql, createPrefix) {
  return sql.replace(createPrefix, (m) => `${m}queuedb.`);
}

main();
