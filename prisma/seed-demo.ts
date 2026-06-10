import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import bcrypt from "bcryptjs";
import { resolveDatabaseUrl } from "../src/lib/db-url";

const adapter = new PrismaBetterSqlite3({ url: resolveDatabaseUrl() });
const prisma = new PrismaClient({ adapter });

async function main() {
  const hashedPassword = await bcrypt.hash("nY*H1#6i#t8kqeP", 12);

  const user = await prisma.user.upsert({
    where: { email: "edwardcheng@uga.edu" },
    update: {},
    create: {
      email: "edwardcheng@uga.edu",
      username: "edward-cheng",
      hashedPassword,
      firstName: "Edward",
      lastName: "Cheng",
      role: "TEACHER",
      teacher: { create: {} },
    },
  });

  console.log(`Demo teacher created: ${user.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
