"use client";

import { Button } from "@terrablox/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@terrablox/ui/dialog";
import { Skeleton } from "@terrablox/ui/skeleton";
import {
  AlertCircle,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  PanelRightClose,
  Send,
  Settings2,
  User,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  AgentStep,
  ProjectChatMessageDto,
  ProjectGraph,
} from "@/lib/projects/types";
import { AgentSettingsPanel } from "./agent-settings-panel";
import { ChatModelPicker, type ModelSelection } from "./chat-model-picker";

/** Overridden per turn from the composer; these are only the starting point. */
const DEFAULT_SELECTION: ModelSelection = {
  model: "claude-opus-5",
  reasoningEffort: "high",
};

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
  const [selection, setSelection] = useState<ModelSelection>(DEFAULT_SELECTION);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch(`/api/projects/${projectId}/chat`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? "Failed to load messages");
        if (!cancelled) setMessages(body.messages ?? []);
      })
      .catch(() => {
        // A missing transcript must not block the canvas; the user can still
        // send a message, which reports its own errors.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    if (messages.length === 0) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const message = input.trim();
    if (!message || sending) return;

    setSending(true);
    setError(null);
    setInput("");

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

      // Failed turns still return the stored messages, so the transcript stays
      // truthful about what was asked and what went wrong.
      if (body?.messages) {
        setMessages((current) => [...current, ...body.messages]);
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
          conversation the settings apply to, and the dialog keeps it in view. */}
      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Agent settings for this project</DialogTitle>
            <DialogDescription>
              Each setting follows your global agent settings until you take it
              over here. Only this project is affected.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[65vh] overflow-y-auto pr-1">
            <AgentSettingsPanel projectId={projectId} />
          </div>
        </DialogContent>
      </Dialog>

      <div className="flex-1 space-y-3 overflow-y-auto p-3">
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
        {sending ? (
          <p className="text-xs text-muted-foreground">
            The agent is thinking…
          </p>
        ) : null}
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
            className="min-h-10 flex-1 resize-none border-0 bg-transparent px-2 py-2 text-sm leading-5 ring-0 placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0"
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
            disabled={sending}
            onChange={setSelection}
            value={selection}
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0"
            onClick={() => setSettingsOpen(true)}
            aria-label="Agent settings for this project"
            title="Settings"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
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
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-muted">
        {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
      </div>
      <div
        className={`flex max-w-[85%] flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
      >
        <div
          className={`whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
            isUser ? "bg-primary text-primary-foreground" : "bg-muted"
          }`}
        >
          {message.content}
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
                  <li
                    key={`${index}-${step.kind === "thought" ? step.text : step.summary}`}
                    className="flex gap-2 text-xs"
                  >
                    {step.kind === "thought" ? (
                      <>
                        <Brain className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className="text-muted-foreground">
                          {step.text}
                        </span>
                      </>
                    ) : (
                      <>
                        {step.ok ? (
                          <Wrench className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                        ) : (
                          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-destructive" />
                        )}
                        <span className={step.ok ? "" : "text-destructive"}>
                          {step.summary}
                        </span>
                      </>
                    )}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}
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
