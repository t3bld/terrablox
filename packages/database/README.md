# @terrablox/database

Database client implemented using Prisma ORM to provide a flexible database integration. 
Just provide the connection string of your SQL database that is compatible with Prisma to the environment file.

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
import { database } from "@terrablox/database";

const projects = await database.project.findMany({
  where: { userId },
  orderBy: { createdAt: "desc" },
});

const project = await database.project.findUnique({
  where: { id },
});

const newProject = await database.project.create({
  data: { userId, name: "My Project" },
});

await database.project.update({
  where: { id },
  data: { name: "Updated Name" },
});

await database.project.delete({ where: { id } });
```

### 2. Add environment variable

```env
DATABASE_URL=
```