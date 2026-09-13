import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { resolveDatabaseUrl } from "../src/lib/db-url";

const adapter = new PrismaBetterSqlite3({ url: resolveDatabaseUrl() });
const prisma = new PrismaClient({ adapter });

async function main() {
  // Never provision a known-credential account against a production database.
  if (process.env.NODE_ENV === "production") {
    console.log("seed-demo: refusing to run with NODE_ENV=production. Skipping.");
    return;
  }

  // Credential comes from the environment; if unset, generate a random one and
  // print it once. No password literal is ever committed to the repo.
  const email = process.env.DEMO_SEED_EMAIL || "demo-teacher@example.com";
  const username = process.env.DEMO_SEED_USERNAME || "demo-teacher";
  const password = process.env.DEMO_SEED_PASSWORD || crypto.randomBytes(12).toString("base64url");
  const hashedPassword = await bcrypt.hash(password, 12);

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      username,
      hashedPassword,
      firstName: "Demo",
      lastName: "Teacher",
      role: "TEACHER",
      teacher: { create: {} },
    },
  });

  console.log(`Demo teacher ready: ${user.email}`);
  if (!process.env.DEMO_SEED_PASSWORD) {
    console.log(`  Generated password (set DEMO_SEED_PASSWORD to control): ${password}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
