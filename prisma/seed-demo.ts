import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

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
