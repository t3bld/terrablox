-- CreateTable
CREATE TABLE "public"."agent_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "mission" TEXT NOT NULL,
    "autonomy" TEXT NOT NULL DEFAULT 'supervised',
    "status" TEXT NOT NULL DEFAULT 'planning',
    "plan_summary" TEXT,
    "assumptions" JSONB NOT NULL DEFAULT '[]',
    "base_branch" TEXT NOT NULL,
    "base_sha" TEXT,
    "branch" TEXT NOT NULL,
    "max_iterations" INTEGER NOT NULL DEFAULT 20,
    "iterations" INTEGER NOT NULL DEFAULT 0,
    "commits" JSONB NOT NULL DEFAULT '[]',
    "pending_guidance" JSONB NOT NULL DEFAULT '[]',
    "question" TEXT,
    "live_steps" JSONB,
    "model" TEXT,
    "pr_number" INTEGER,
    "pr_url" TEXT,
    "outcome" TEXT,
    "error" TEXT,
    "heartbeat_at" TIMESTAMPTZ(6),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_run_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "phase" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "depends_on" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."agent_run_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "run_id" UUID NOT NULL,
    "task_id" UUID,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "agent_runs_project_id_created_at_idx" ON "public"."agent_runs"("project_id", "created_at");

-- CreateIndex
CREATE INDEX "agent_runs_status_idx" ON "public"."agent_runs"("status");

-- CreateIndex
CREATE INDEX "agent_run_tasks_run_id_position_idx" ON "public"."agent_run_tasks"("run_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "agent_run_tasks_run_id_key_key" ON "public"."agent_run_tasks"("run_id", "key");

-- CreateIndex
CREATE INDEX "agent_run_events_run_id_created_at_idx" ON "public"."agent_run_events"("run_id", "created_at");

-- AddForeignKey
ALTER TABLE "public"."agent_runs" ADD CONSTRAINT "agent_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_runs" ADD CONSTRAINT "agent_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_run_tasks" ADD CONSTRAINT "agent_run_tasks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
