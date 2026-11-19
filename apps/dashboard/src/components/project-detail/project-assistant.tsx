"use client";

import {
  Bot,
  ChevronDown,
  Maximize2,
  MessageSquare,
  Minimize2,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  type AgentAttention,
  AgentModePanel,
} from "@/components/agent-mode/agent-mode-panel";
import type { ProjectGraph } from "@/lib/projects/types";
import { ChatPanel } from "./chat-panel";

type AssistantMode = "chat" | "agent";
type AssistantSize = "compact" | "expanded";

interface AssistantPrefs {
  open: boolean;
  mode: AssistantMode;
  /** Remembered per mode: a chat fits a corner, a mission wants room. */
  size: Record<AssistantMode, AssistantSize>;
}

const DEFAULT_PREFS: AssistantPrefs = {
  open: true,
  mode: "chat",
  size: { chat: "compact", agent: "expanded" },
};

/** Per browser rather than per project: it is a preference about the window. */
const STORAGE_KEY = "terrablox.project-assistant";

function readPrefs(): AssistantPrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<AssistantPrefs>;
    const size = (value: unknown, fallback: AssistantSize): AssistantSize =>
      value === "compact" || value === "expanded" ? value : fallback;
    return {
      open: typeof parsed.open === "boolean" ? parsed.open : true,
      mode: parsed.mode === "agent" ? "agent" : "chat",
      size: {
        chat: size(parsed.size?.chat, "compact"),
        agent: size(parsed.size?.agent, "expanded"),
      },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

interface ProjectAssistantProps {
  projectId: string;
  /** Called when a chat turn changed the repository, so the canvas can refresh. */
  onGraphChanged: (graph: ProjectGraph) => void;
  /**
   * Whether the window is shown at all. Hidden rather than unmounted, so its
   * state survives a visit to another tab.
   */
  visible?: boolean;
}

/**
 * The project's assistant: one window, bottom right, on every tab.
 *
 * Two modes behind one switch. Chat is the conversation that used to live in the
 * Architecture tab's right column: one turn at a time, edits committed to the
 * project branch. Agent is the mission control that used to be its own tab: a
 * multi-step run that plans and builds a whole mission on the same branch.
 *
 * Both stay mounted whatever is showing, so a half-written message, a scrolled
 * transcript or a mission being watched all survive a switch, a minimise and a
 * change of tab.
 */
export function ProjectAssistant({
  projectId,
  onGraphChanged,
  visible = true,
}: ProjectAssistantProps) {
  const [prefs, setPrefs] = useState<AssistantPrefs>(DEFAULT_PREFS);
  const [attention, setAttention] = useState<AgentAttention>(null);

  // Read after mounting: the server cannot know it, and rendering something else
  // than it did would be a hydration mismatch.
  useEffect(() => {
    const stored = readPrefs();

    // `#agent` used to be a tab of its own. Links and bookmarks to it now open
    // the window in Agent mode instead of landing nowhere.
    if (window.location.hash === "#agent") {
      setPrefs({ ...stored, open: true, mode: "agent" });
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}`,
      );
      return;
    }
    setPrefs(stored);
  }, []);

  const update = useCallback(
    (change: (current: AssistantPrefs) => AssistantPrefs) => {
      setPrefs((current) => {
        const next = change(current);
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Private mode or a full quota: the window still works, it just forgets.
        }
        return next;
      });
    },
    [],
  );

  const setMode = (mode: AssistantMode) =>
    update((current) => ({ ...current, mode, open: true }));
  const toggleSize = () =>
    update((current) => ({
      ...current,
      size: {
        ...current.size,
        [current.mode]:
          current.size[current.mode] === "compact" ? "expanded" : "compact",
      },
    }));
  const setOpen = (open: boolean) =>
    update((current) => ({ ...current, open }));

  const size = prefs.size[prefs.mode];
  const expanded = size === "expanded";

  return (
    <>
      <section
        aria-label="Project assistant"
        className={`fixed z-40 flex flex-col overflow-hidden border bg-background shadow-2xl transition-[width,height,top] duration-200 max-sm:inset-0 max-sm:rounded-none sm:right-4 sm:bottom-4 sm:rounded-2xl ${
          expanded
            ? "sm:top-[4.5rem] sm:w-[min(1200px,calc(100vw-2rem))]"
            : "sm:h-[min(720px,calc(100svh-6rem))] sm:w-[min(440px,calc(100vw-2rem))]"
        } ${prefs.open && visible ? "fade-in slide-in-from-bottom-4 animate-in" : "hidden"}`}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-muted/20 pr-1.5 pl-2">
          <div
            className="flex items-center rounded-lg border bg-background p-0.5"
            role="tablist"
            aria-label="Assistant mode"
          >
            <ModeButton
              active={prefs.mode === "chat"}
              onClick={() => setMode("chat")}
              icon={MessageSquare}
              label="Chat"
              hint="Ask and edit, one turn at a time, on the project branch"
            />
            <ModeButton
              active={prefs.mode === "agent"}
              onClick={() => setMode("agent")}
              icon={Bot}
              label="Agent"
              hint="Hand over a mission; the agent plans and builds it step by step"
              attention={attention}
            />
          </div>

          <span className="flex-1" />

          <button
            type="button"
            onClick={toggleSize}
            className="hidden h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground sm:flex"
            aria-label={
              expanded ? "Make the window smaller" : "Make the window larger"
            }
            title={expanded ? "Smaller" : "Larger"}
          >
            {expanded ? (
              <Minimize2 className="h-4 w-4" />
            ) : (
              <Maximize2 className="h-4 w-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Minimise the assistant"
            title="Minimise"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        </header>

        <div
          className={`min-h-0 flex-1 ${prefs.mode === "chat" ? "flex flex-col" : "hidden"}`}
          role="tabpanel"
          aria-label="Chat"
        >
          <ChatPanel
            projectId={projectId}
            onGraphChanged={onGraphChanged}
            hideHeader
          />
        </div>
        <div
          className={`min-h-0 flex-1 ${prefs.mode === "agent" ? "flex flex-col" : "hidden"}`}
          role="tabpanel"
          aria-label="Agent"
        >
          <AgentModePanel
            projectId={projectId}
            compact={!expanded}
            onAttention={setAttention}
            onGraphChanged={onGraphChanged}
          />
        </div>
      </section>

      {prefs.open || !visible ? null : (
        <Launcher attention={attention} onOpen={() => setOpen(true)} />
      )}
    </>
  );
}

function ModeButton({
  active,
  onClick,
  icon: Icon,
  label,
  hint,
  attention = null,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Bot;
  label: string;
  hint: string;
  attention?: AgentAttention;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      title={hint}
      className={`relative flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium text-xs transition-colors ${
        active
          ? "bg-secondary text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
      {attention ? <AttentionDot attention={attention} /> : null}
    </button>
  );
}

function AttentionDot({ attention }: { attention: AgentAttention }) {
  const color = attention === "waiting" ? "bg-amber-500" : "bg-sky-500";
  return (
    <span className="relative flex h-2 w-2">
      <span
        className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${color}`}
      />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

/**
 * What is left of the window when it is minimised.
 *
 * Says when a mission needs the user, so minimising never means missing a plan
 * that is waiting for approval.
 */
function Launcher({
  attention,
  onOpen,
}: {
  attention: AgentAttention;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="fade-in slide-in-from-bottom-2 fixed right-4 bottom-4 z-40 flex animate-in items-center gap-2 rounded-full border bg-background py-2 pr-4 pl-2 shadow-lg transition-shadow hover:shadow-xl"
      aria-label="Open the assistant"
    >
      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-violet-600 to-sky-600 text-white">
        <Sparkles className="h-4 w-4" />
      </span>
      <span className="font-medium text-sm">
        {attention === "waiting"
          ? "Agent needs you"
          : attention === "working"
            ? "Agent is working…"
            : "Assistant"}
      </span>
      {attention ? <AttentionDot attention={attention} /> : null}
    </button>
  );
}
