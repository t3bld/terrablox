<p align="center">
	<h1 align="center"><b>Terrablox</b></h1>
<p align="center">
    Cloud migrations at lightspeed, on an opinionated agent harness
    <br />
    <br />
    <a href="https://terrablox.de">Website</a>
    ·
    <a href="https://github.com/t3bld/terrablox/issues">Issues</a>
    ·
   <a href="https://terrablox.de/docs">Documentation</a>
  </p>
</p>

## ✨ Key Features

- **Agent Harness**: Powers your agent with best practises to create infrastructure
- **Architecture Graphs**: Visualize and analyze your infrastructure 
- **Terraform Library**: Curated catalogue of production-ready modules
- **Cost Transparency**: The complete cost structure of your infrastructure
- **1-Click Deployments**: Seamless cloud provider integration

## ⚙️ Tech Stack

Terrablox is designed to be **self-hosted** —  no required managed services.

- [TypeScript](https://www.typescriptlang.org/) – Language
- [Turborepo](https://turborepo.com/) & [pnpm](https://pnpm.io/)  – Monorepo
- [Next.js](https://nextjs.org/) – React Framework
- [React](https://react.dev/), [TailwindCSS](https://tailwindcss.com/) & [shadcn](https://ui.shadcn.com/) – UI
- [React Flow](https://reactflow.dev/) & [Dagre](https://github.com/dagrejs/dagre) – Graph Rendering
- [Prisma](https://prisma.io/) – ORM
- [PostgreSQL](https://www.postgresql.org/) – Database
- [Better Auth](https://better-auth.com/) – Authentication 
- [GitHub Copilot SDK](https://github.com/github/copilot-sdk) – AI Integration

## 🚀 Quick Start

You need [Node.js](https://nodejs.org/en), [pnpm](https://pnpm.io/) and [Docker](https://docs.docker.com/get-docker/).

```bash
pnpm quickstart
```

This starts the guided local setup. Afterwards you can access the dashboard via http://localhost:3001.

Quickstart guides you through these steps:

1. Checks Node.js (22+), pnpm and Docker, and creates the root `.env` if needed.
2. Asks for your GitHub App client ID and secret. Either register your own app
   or request access to the existing Terrablox GitHub App from its owner. See
   [GitHub App setup](docs/quickstart.md#github-app-setup); the script does not
   create or install the app for you. Enter the app's slug when prompted.
3. Installs dependencies, starts PostgreSQL and applies database migrations.
4. Optionally configures and starts the Cost Service. Create an Infracost token
   under **Org Settings → API tokens** and provide it when prompted.
5. Optionally imports the shared Terrablox Terraform module catalogue. Provide
   a GitHub token or sign in with `gh auth login` first.
6. Starts the development servers, unless port 3001 is already in use.

The optional steps default to no and are skipped in non-interactive terminals.
Re-run `pnpm quickstart` to set them up later; existing configuration and data
are preserved unless you explicitly change the app slug. Use `pnpm quickstart
--no-dev` to set up without starting the development servers. See the [full
quickstart](docs/quickstart.md) for manual setup, credentials and troubleshooting.