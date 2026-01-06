# @terrablox/database

Database client implemented using Prisma ORM to provide a flexible database integration. Just provide the connection string to your SQL database that is compatible with Prisma and you can use your own database service.

- [Features](#features)
- [Installation](#installation)
- [Quick Start](#quick-start)

## Features

- **Flexible Database Usage:** Use any SQL database supported by Prisma

## Installation

```bash
pnpm add @terrablox/database
```

## Quick Start

### 1. Add database client to the app

```typescript
import { db } from "@terrablox/database";

const projects = await db.project.findMany({
  where: { userId },
  orderBy: { createdAt: "desc" },
});

const project = await db.project.findUnique({
  where: { id },
});

const newProject = await db.project.create({
  data: { userId, name: "My Project" },
});

await db.project.update({
  where: { id },
  data: { name: "Updated Name" },
});

await db.project.delete({ where: { id } });
```

### 2. Add environment variable

```env
DATABASE_URL=
```

### 3. Prisma Commands

```bash
pnpm db:generate      # Generate Prisma client
pnpm db:push          # Push schema to database
pnpm db:pull          # Pull schema from database
pnpm db:migrate:dev   # Create migration (dev)
pnpm db:migrate:deploy # Deploy migrations (prod)
pnpm db:studio        # Open Prisma Studio
```