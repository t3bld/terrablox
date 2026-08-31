"use client";

import { Button } from "@terrablox/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@terrablox/ui/popover";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Gauge,
  Loader2,
  PanelRightClose,
  Send,
  Settings2,
  User,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AgentHarness } from "@/components/agent/agent-harness";
import {
  CopilotPlanSummary,
  type CopilotStatus,
} from "@/components/agent/copilot-plan-summary";
import type { CopilotPlan } from "@/lib/agent/copilot-plan";
import type {
  AgentStep,
  ProjectChatMessageDto,
  ProjectGraph,
} from "@/lib/projects/types";
import { AgentMarkdown } from "./agent-markdown";
import { ChatModelPicker, type ModelSelection } from "./chat-model-picker";

/**
 * What the composer shows before this project's settings have loaded.
 *
 * Deliberately not a real model id: it is replaced within one request, and a
 * plausible-looking id here is a value someone could send a turn with by being
 * quick, without it ever having been chosen.
 */
const UNKNOWN_SELECTION: ModelSelection = {
  model: "",
  reasoningEffort: "",
};

/**
 * How often the running turn is asked what it is doing, in ms.
 *
 * Matched to the interval the server writes progress at, since polling faster
 * than that only re-reads the same trail.
 */
const STATUS_POLL_INTERVAL_MS = 2_000;

interface ChatPanelProps {
  projectId: string;
  /** Called when a turn changed the repository, so the canvas can refresh. */
  onGraphChanged: (graph: ProjectGraph) => void;
  /** Omitted where the panel cannot be hidden. */
  onCollapse?: () => void;
}

/**
 * The agent conversation.
 *
 * The transcript lives on the server, so a reload does not lose it and the
 * agent can be given its own history as context.
 */
export function ChatPanel({
  projectId,
  onGraphChanged,
  onCollapse,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ProjectChatMessageDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ModelSelection>(UNKNOWN_SELECTION);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** This project's stored overrides, so a save can resend the ones it is not changing. */
  const overridesRef = useRef<Record<string, unknown>>({});
  /**
   * The Copilot licence this project's turns are spent against.
   *
   * Next to the composer because that is where the spending happens. The whole
   * plan rather than one number, so the popover can explain what the number
   * means instead of leaving a bare percentage to be read as "used".
   */
  const [copilotPlan, setCopilotPlan] = useState<CopilotPlan | null>(null);
  /** The running turn's trail, refreshed by the status poll. */
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);

  /**
   * Percent of the metered budget still available, or null when there is no
   * budget to report — an unlimited plan, an unlinked account, or the
   * undocumented endpoint changing shape. Then nothing is shown, rather than a
   * zero that would read as "out of requests".
   */
  const premium = copilotPlan?.premium;
  const creditsLeft =
    premium && !premium.unlimited ? Math.round(premium.percentRemaining) : null;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /**
   * Watches for the turn to finish, for a turn this tab did not start.
   *
   * The running flag lives on the project rather than in this component, so a
   * reload or a detour to another page still comes back to a spinner. Polling is
   * how that spinner learns it can stop.
   */
  const startPolling = useCallback(
    /**
     * `ownTurn` marks the case where this tab is the one waiting on the POST.
     * Then the poll reports progress only: completion is the awaited response's
     * job, and treating a not-yet-`true` flag as "finished" would end the turn in
     * the UI moments after starting it.
     */
    (options?: { ownTurn?: boolean }) => {
      stopPolling();

      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/projects/${projectId}/chat/status`);
          if (!res.ok) return;
          const body = await res.json();

          if (body.running !== false || options?.ownTurn) {
            // Progress for the panel below the transcript. Same poll: what the
            // turn is doing and whether it still runs are one answer.
            setLiveSteps(Array.isArray(body.steps) ? body.steps : []);
            return;
          }

          stopPolling();
          setLiveSteps([]);

          // Re-read the transcript rather than trusting the poll: the reply was
          // written by whichever request ran the turn, not by this one.
          const msgRes = await fetch(`/api/projects/${projectId}/chat`);
          if (msgRes.ok) {
            const msgBody = await msgRes.json();
            setMessages(msgBody.messages ?? []);
          }
          setSending(false);
        } catch {
          // Swallowed: polling is best-effort.
        }
      }, STATUS_POLL_INTERVAL_MS);
    },
    [projectId, stopPolling],
  );

  /**
   * Reads the model and effort this project is set to.
   *
   * The composer used to start from a hardcoded pair, which meant the settings
   * screen and the picker two centimetres below it could disagree about what the
   * next turn would run on. There is one answer now, and it comes from the
   * project — so `?projectId=` matters: the same request without it would report
   * the user's defaults, which is what a *new* project would inherit, not what
   * this one uses.
   */
  const loadSelection = useCallback(async () => {
    try {
      const response = await fetch(
        `/api/agent/context?projectId=${encodeURIComponent(projectId)}`,
      );
      if (!response.ok) return;

      const body = (await response.json()) as {
        model: string | null;
        reasoningEffort: string | null;
        defaults: { model: string; reasoningEffort: string };
        overrides?: Record<string, unknown>;
      };

      overridesRef.current = body.overrides ?? {};

      setSelection({
        model: body.model ?? body.defaults.model,
        reasoningEffort: body.reasoningEffort ?? body.defaults.reasoningEffort,
      });
    } catch {
      // The picker keeps showing nothing and `send` refuses; better than
      // inventing a model the user never chose.
    }
  }, [projectId]);

  useEffect(() => {
    void loadSelection();
  }, [loadSelection]);

  // Re-read after every turn as well as on mount: the number the composer shows
  // is only useful if it moves when requests are spent.
  useEffect(() => {
    if (sending) return;

    let cancelled = false;

    fetch("/api/copilot/status")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: CopilotStatus | null) => {
        if (cancelled) return;
        setCopilotPlan(body?.plan ?? null);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [sending]);

  /**
   * Persists a change made in the composer to this project.
   *
   * The picker is no longer a per-turn override. Two controls for one decision,
   * one of them forgetting on reload, is the thing that made them look
   * disconnected in the first place.
   */
  const changeSelection = useCallback(
    (next: ModelSelection) => {
      setSelection(next);

      void fetch(`/api/projects/${projectId}/agent-settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // The endpoint replaces the whole override object, so the rest of it —
        // the timeout, the knowledge and operation deny lists — has to be sent
        // back untouched. Sending only the two fields would silently reset them.
        body: JSON.stringify({
          ...overridesRef.current,
          model: next.model,
          reasoningEffort: next.reasoningEffort,
        }),
      })
        .then(() => loadSelection())
        .catch(() => undefined);
    },
    [projectId, loadSelection],
  );

  // Load messages and check if the agent is already running (e.g. after a
  // navigation away and back while a turn was in-flight).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    Promise.all([
      fetch(`/api/projects/${projectId}/chat`).then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Failed to load messages");
        return (body.messages ?? []) as ProjectChatMessageDto[];
      }),
      fetch(`/api/projects/${projectId}/chat/status`).then(async (res) => {
        if (!res.ok) return null;
        const body = await res.json();
        return body.running === true
          ? {
              steps: (Array.isArray(body.steps)
                ? body.steps
                : []) as AgentStep[],
            }
          : null;
      }),
    ])
      .then(([msgs, inFlight]) => {
        if (cancelled) return;
        setMessages(msgs);
        if (inFlight) {
          // Arriving mid-turn shows the progress so far rather than starting the
          // trail over from whatever happens next.
          setSending(true);
          setLiveSteps(inFlight.steps);
          startPolling();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      stopPolling();
    };
  }, [projectId, startPolling, stopPolling]);

  useEffect(() => {
    if (messages.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const message = input.trim();
    if (!message || sending) return;
    // The project's settings decide the model, so a turn before they have loaded
    // would run on whatever the server falls back to rather than on the choice
    // the user can see. It is a matter of one request.
    if (!selection.model) return;

    setSending(true);
    setError(null);
    setInput("");
    // The POST below is awaited for the whole turn, so the progress the panel
    // shows in the meantime has to come from somewhere else.
    setLiveSteps([]);
    startPolling({ ownTurn: true });

    // Optimistic: show the user's message immediately, before the server
    // responds. The id is temporary — it will be replaced by the real one
    // when the POST returns.
    const optimisticMsg: ProjectChatMessageDto = {
      id: `pending-${Date.now()}`,
      role: "user",
      content: message,
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimisticMsg]);

    try {
      const response = await fetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        }),
      });

      const body = await response.json();

      if (body?.messages) {
        // Replace the optimistic message with the server's pair (user +
        // assistant). The optimistic message has a `pending-` id prefix.
        setMessages((current) => [
          ...current.filter((m) => !m.id.startsWith("pending-")),
          ...body.messages,
        ]);
      }

      if (!response.ok) {
        throw new Error(body?.error ?? "The agent could not answer");
      }

      if (body.graph) onGraphChanged(body.graph as ProjectGraph);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "The agent could not answer",
      );
    } finally {
      setSending(false);
      stopPolling();
      setLiveSteps([]);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b p-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Agent</h2>
        </div>

        {onCollapse ? (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={onCollapse}
            aria-label="Collapse agent panel"
          >
            <PanelRightClose className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {/* A modal, not a tab: tuning the agent is a short detour from the
          conversation the settings apply to, and the dialog keeps it in view.
          The same harness view as the settings screen, so there is one picture of
          the agent rather than two that can disagree. */}
      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className="max-h-[92vh] w-[95vw] max-w-6xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Agent Harness</DialogTitle>
          </DialogHeader>

          {/* Scoped to this project: the same view, but every change here is an
              override on this project rather than an edit to the defaults. The
              callback is what keeps the composer's picker in step.

              `withHeading={false}` because the dialog above already says "Agent
              Harness" — with it on, the same two words appeared twice with a card
              border between them. */}
          <AgentHarness
            onChanged={() => void loadSelection()}
            projectId={projectId}
            withHeading={false}
          />
        </DialogContent>
      </Dialog>

      {/* `overflow-x-hidden` on purpose: in a 384px column a pasted ARN or a URL
          used to scroll the whole conversation sideways. Nothing here may widen
          past the column, so every child below is given something to wrap
          against rather than a horizontal scrollbar to hide behind. */}
      <div className="min-w-0 flex-1 space-y-3 overflow-y-auto overflow-x-hidden p-3">
        {loading ? (
          <>
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-10 w-2/3" />
          </>
        ) : messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No messages yet. Ask for a change, or for an explanation of what is
            already in the project.
          </p>
        ) : (
          messages.map((message) => (
            <ChatBubble key={message.id} message={message} />
          ))
        )}
        {sending ? <LiveSteps steps={liveSteps} /> : null}
        <div ref={bottomRef} />
      </div>

      {error ? (
        <p className="flex items-start gap-2 border-t px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      ) : null}

      <div className="space-y-2 border-t p-3">
        <div className="flex items-center gap-2 rounded-xl border bg-muted/20 p-2 shadow-sm">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter breaks the line — the convention every
              // chat interface uses.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            placeholder="Describe what to build"
            className="min-h-10 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm leading-5 ring-0 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0"
          />
          <Button
            size="icon"
            className="shrink-0"
            onClick={() => void send()}
            disabled={sending || input.trim().length === 0}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-1.5">
          <ChatModelPicker
            disabled={sending || !selection.model}
            onChange={changeSelection}
            value={selection}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setSettingsOpen(true)}
            aria-label="Agent settings"
            title="Agent settings"
          >
            <Settings2 className="h-4 w-4" />
          </Button>

          {/* "42% left" rather than "42%": the bare number read as the share
              already spent, which is the opposite of what it says. Clicking it
              opens the same licence summary the agent settings screen shows,
              where the count, the reset date and the plan are spelled out. */}
          {creditsLeft !== null ? (
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  className={`ml-auto h-8 shrink-0 px-2 text-xs tabular-nums ${
                    creditsLeft <= 10
                      ? "text-destructive hover:text-destructive"
                      : "text-muted-foreground"
                  }`}
                  size="sm"
                  variant="ghost"
                  aria-label="Copilot premium requests remaining"
                >
                  <Gauge className="mr-1 h-3.5 w-3.5" />
                  {creditsLeft}% left
                </Button>
              </PopoverTrigger>

              <PopoverContent align="end" className="w-80 p-3" side="top">
                {copilotPlan ? (
                  <CopilotPlanSummary framed={false} plan={copilotPlan} />
                ) : null}
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ProjectChatMessageDto }) {
  const [showSteps, setShowSteps] = useState(false);

  if (message.role === "system") {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        {message.content}
      </p>
    );
  }

  const isUser = message.role === "user";
  const steps = readSteps(message.metadata);

  return (
    <div className={`flex min-w-0 gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-muted">
        {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
      </div>
      {/* `min-w-0` is what makes `max-w-[85%]` mean anything: a flex item
          defaults to min-width:auto, so one long token in the bubble let this
          column grow past the cap and take the panel with it. */}
      <div
        className={`flex min-w-0 max-w-[85%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
      >
        {/* The user's own text is shown exactly as typed; only the agent writes
            markdown, and rendering a person's asterisks would change what they
            said. */}
        <div
          className={`min-w-0 rounded-lg px-3 py-2 text-sm ${
            isUser
              ? // `anywhere` rather than `break-words`: it also shrinks the
                // min-content width, which is what a flex parent measures.
                "whitespace-pre-wrap [overflow-wrap:anywhere] bg-primary text-primary-foreground"
              : "bg-muted"
          }`}
        >
          {isUser ? (
            message.content
          ) : (
            <AgentMarkdown>{message.content}</AgentMarkdown>
          )}
        </div>

        {steps.length > 0 ? (
          <div className="w-full">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
              onClick={() => setShowSteps((open) => !open)}
              aria-expanded={showSteps}
            >
              {showSteps ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {showSteps ? "Hide reasoning" : `Reasoning (${steps.length})`}
            </Button>

            {showSteps ? (
              <ol className="mt-1 space-y-1.5 rounded-md border bg-background p-2">
                {steps.map((step, index) => (
                  <StepRow
                    key={`${index}-${step.kind === "thought" ? step.text : step.summary}`}
                    step={step}
                  />
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One entry of the trail. Shared by the finished message and the live progress
 * panel so a step does not change appearance the moment the turn ends.
 */
function StepRow({ step }: { step: AgentStep }) {
  // Tool summaries carry file paths and resource addresses, which are exactly
  // the strings that do not break on their own.
  const textClass = "min-w-0 [overflow-wrap:anywhere]";

  if (step.kind === "thought") {
    return (
      <li className="flex min-w-0 gap-2 text-xs">
        <Brain className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        <span className={`${textClass} text-muted-foreground`}>
          {step.text}
        </span>
      </li>
    );
  }

  return (
    <li className="flex min-w-0 gap-2 text-xs">
      {step.ok ? (
        <Wrench className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
      ) : (
        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
      )}
      <span className={`${textClass} ${step.ok ? "" : "text-destructive"}`}>
        {step.summary}
      </span>
    </li>
  );
}

/**
 * What the agent has done so far, while it is still doing it.
 *
 * Replaces a bare spinner. On a long turn the spinner was the only sign of life
 * for minutes at a time, and a user cannot tell a thinking agent from a stuck one
 * by looking at the same animation either way.
 *
 * The newest step sits at the bottom next to the spinner, so the panel reads
 * downwards like the transcript it is part of, and older ones scroll away rather
 * than pushing the composer off the screen.
 */
function LiveSteps({ steps }: { steps: AgentStep[] }) {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (steps.length === 0) return;
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [steps.length]);

  return (
    <div className="rounded-md border bg-background p-2">
      {steps.length > 0 ? (
        <ol className="max-h-40 space-y-1.5 overflow-y-auto">
          {steps.map((step, index) => (
            <StepRow
              key={`${index}-${step.kind === "thought" ? step.text : step.summary}`}
              step={step}
            />
          ))}
          <div ref={endRef} />
        </ol>
      ) : null}

      <div
        className={`flex items-center gap-2 text-xs text-muted-foreground ${
          steps.length > 0 ? "mt-2 border-t pt-2" : ""
        }`}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        {steps.length > 0 ? "Working…" : "The agent is working…"}
      </div>
    </div>
  );
}

/** Steps come back as plain JSON from the message row, so nothing is trusted. */
function readSteps(metadata: Record<string, unknown>): AgentStep[] {
  const raw = metadata.steps;
  if (!Array.isArray(raw)) return [];

  const steps: AgentStep[] = [];

  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const step = entry as Record<string, unknown>;

    if (step.kind === "thought" && typeof step.text === "string") {
      steps.push({ kind: "thought", text: step.text });
    } else if (step.kind === "tool" && typeof step.summary === "string") {
      steps.push({
        kind: "tool",
        tool: typeof step.tool === "string" ? step.tool : "tool",
        summary: step.summary,
        ok: step.ok !== false,
      });
    }
  }

  return steps;
}
