import { defineConfig } from "prisma/config";
import { resolveDatabaseUrl } from "./src/lib/db-url";

// Prisma 7 no longer reads the connection URL from `schema.prisma`. CLI/Migrate
// commands (`prisma db push`, `prisma migrate`) read it from here; the runtime
// client gets its connection via the driver adapter in src/lib/prisma.ts.
//
// DATABASE_URL is provided by the environment (.env locally via Next.js, the
// container env in production, and an explicit override in the test harness).
// resolveDatabaseUrl re-anchors relative paths to prisma/ and makes them
// absolute so the CLI writes to the exact file the runtime client reads.
export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: resolveDatabaseUrl(),
  },
});
