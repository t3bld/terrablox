"use client";

import { Button } from "@terrablox/ui/button";
import { Skeleton } from "@terrablox/ui/skeleton";
import { AlertCircle, Bot, PanelRightClose, Send, User } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ProjectChatMessageDto, ProjectGraph } from "@/lib/projects/types";

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
        body: JSON.stringify({ message }),
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
      <div className="flex items-start gap-2 border-b p-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">Agent</h2>
          <p className="text-xs text-muted-foreground">
            Describe what you want; changes land in the repository.
          </p>
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

      <div className="border-t p-3">
        <div className="flex items-end gap-2">
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
            placeholder="Add a VPC and connect it to the database…"
            className="flex-1 resize-none rounded-md border bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button
            size="icon"
            onClick={() => void send()}
            disabled={sending || input.trim().length === 0}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ProjectChatMessageDto }) {
  if (message.role === "system") {
    return (
      <p className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
        {message.content}
      </p>
    );
  }

  const isUser = message.role === "user";

  return (
    <div className={`flex gap-2 ${isUser ? "flex-row-reverse" : ""}`}>
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-muted">
        {isUser ? <User className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
      </div>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
          isUser ? "bg-primary text-primary-foreground" : "bg-muted"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}
