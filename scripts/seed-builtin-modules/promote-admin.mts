import { prisma } from "@/lib/database";

function emailArgument(argv: string[]): string {
  const index = argv.indexOf("--email");
  const email = index >= 0 ? argv[index + 1]?.trim().toLowerCase() : "";

  if (!email || !email.includes("@")) {
    console.error("Usage: pnpm db:user:promote --email user@example.com");
    process.exit(2);
  }

  return email;
}

async function main() {
  const email = emailArgument(process.argv.slice(2));
  const result = await prisma.user.updateMany({
    where: { email },
    data: { systemRole: "admin" },
  });

  if (result.count !== 1) {
    console.error(
      `No user account exists for '${email}'. Sign in once, then retry.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Granted instance administrator access to ${email}.`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
