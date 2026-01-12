<p align="center">
	<h1 align="center"><b>TerraBlox</b></h1>
<p align="center">
    Open Source Terraform Assistant and Infrastructure Designer
    <br />
    <br />
    <a href="https://terrablox.de">Website</a>
    ·
    <a href="https://github.com/t3bld/terrablox/issues">Issues</a>
    ·
    <a href="https://github.com/ttt/issues">Documentation</a>
    ·
    <a href="https://github.com/t3bld/terrablox?tab=AGPL-3.0-1-ov-file">License</a>
    ·
    <a href="https://github.com/t3bld/terrablox">Contribute</a>
  </p>
</p>

## ✨ Key Features

- **Terraform Analyzer**: Get a clear understanding of the cloud infrastructure and its dependencies (WIP)
- **Low-Code Builder**: Visually construct and configure cloud infrastructure (SOON)

## ⚙️ Tech Stack

- [Turborepo](https://turborepo.com/) – Monorepo
- [pnpm](https://pnpm.io/) – Package Manager
- [Next.js](https://nextjs.org/) – React Framework
- [TypeScript](https://www.typescriptlang.org/) – Language
- [TailwindCSS](https://tailwindcss.com/) – Styling
- [shadcn/ui](https://ui.shadcn.com/) - UI Components
- [Prisma](https://prisma.io/) - ORM

- [Vercel](https://vercel.com/) – Hosting



For all service integrations you can implement your own adapters or use the provided default ones.

- [Supabase](https://supabase.com/) – Database & Auth

## 🚀 Quick Start

We recommend using the default Supabase integration to start with. Later, you can implement your own adapters for backend services if necessary.

1. Create a project at [supabase.com](https://supabase.com)
2. Get your project URL and anon key and add them to `apps/dashboard/.env`
3. Get your project database connection string and add it to `apps/dashboard/.env`
4. Run `pnpm install`
5. Run `cp apps/dashboard/.env.example apps/dashboard/.env`
6. Run `pnpm dev` to start the development servers

- Dashboard: http://localhost:3001
If you'd like to contribute, please fork the repository and make any changes you'd like. Pull requests are warmly welcome.



