import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { resolveDatabaseUrl } from "../src/lib/db-url";
import {
  OFFICIAL_CONSENT_FORMS,
  OFFICIAL_CONSENT_VERSION,
  type OfficialConsentForm,
} from "../src/lib/consent-form-templates";

// Idempotent, additive-only seed for the IRB consent forms — mirrors
// seed-prebuilt.ts's "skip if it already exists" pattern rather than
// seed.ts's destructive wipe, since this must be safe to run against a live
// production database. It is part of `npm run deploy`, and must stay part of
// any deploy path: with no published version a student sees no form at all
// and a teacher has nothing to agree to, which is what the consent screens
// looking "blank" always means.
//
// The form text itself lives in src/lib/consent-form-templates.ts (shared
// with the admin publish screen). Publishing a genuinely new revision later
// should go through the admin UI, which appends a new version and deactivates
// the old one, rather than re-running this script with edited text.

const adapter = new PrismaBetterSqlite3({ url: resolveDatabaseUrl() });
const prisma = new PrismaClient({ adapter });

async function upsertVersion({
  role,
  version,
  title,
  bodyHtml,
}: OfficialConsentForm) {
  const existing = await prisma.consentFormVersion.findUnique({
    where: { role_version: { role, version } },
  });
  if (existing) {
    console.log(
      `  ${role} form ${version} already exists — skipping (active: ${existing.isActive}).`,
    );
    return;
  }

  await prisma.$transaction([
    prisma.consentFormVersion.updateMany({
      where: { role, isActive: true },
      data: { isActive: false },
    }),
    prisma.consentFormVersion.create({
      data: { role, version, title, bodyHtml, isActive: true },
    }),
  ]);
  console.log(`  Created and activated ${role} form ${version}.`);
}

async function main() {
  console.log(
    `Seeding IRB consent form versions (${OFFICIAL_CONSENT_VERSION})...`,
  );
  await upsertVersion(OFFICIAL_CONSENT_FORMS.STUDENT);
  await upsertVersion(OFFICIAL_CONSENT_FORMS.TEACHER);

  const existingSettings = await prisma.consentExportSettings.findUnique({
    where: { id: "singleton" },
  });
  if (!existingSettings) {
    await prisma.consentExportSettings.create({ data: { id: "singleton" } });
    console.log("  Created default ConsentExportSettings row.");
  } else {
    console.log("  ConsentExportSettings row already exists — skipping.");
  }

  // Surface the state that actually matters to the running app, so a deploy
  // log shows at a glance whether anyone will be shown a form.
  const active = await prisma.consentFormVersion.findMany({
    where: { isActive: true },
    select: { role: true, version: true },
  });
  const activeByRole = new Map(active.map((v) => [v.role, v.version]));
  for (const role of ["STUDENT", "TEACHER"] as const) {
    const version = activeByRole.get(role);
    console.log(
      version
        ? `  Active ${role} form: ${version}`
        : `  WARNING: no active ${role} form — ${role.toLowerCase()}s will not be asked to consent.`,
    );
  }

  console.log("Consent seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
