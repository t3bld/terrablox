"use client";

import { ArchitectureDiagram } from "@terrablox/graph";
import { Button } from "@terrablox/ui/button";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CornerDownLeft,
  FileText,
  GitBranch,
  HelpCircle,
  Loader2,
  MessageSquare,
  RotateCcw,
  Send,
  Server,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { diagramFor } from "@/lib/demo-graphs";
import {
  DEFAULT_SCENARIO,
  DEPLOY_STEPS,
  type DemoScenario,
  matchScenario,
  SCENARIOS,
} from "@/lib/demo-scenarios";

/**
 * The walk-through, as the three things the product actually asks of you.
 *
 * It replaced a single composer that resolved text to modules. That showed the
 * cleverest step and skipped the two a buyer actually worries about: where the
 * requirements come from, and what it takes to get the result into an AWS account.
 * A visitor who only saw the middle step could reasonably conclude this was a
 * diagram generator.
 *
 * The three steps are the product's own — its context sources, its agent turn, its
 * deployment wizard — so the page and the software describe one flow.
 *
 * It is the only client component on the site, which is a deliberate exception: the
 * rest is a static export with no JavaScript, the right trade for prose and the
 * wrong one for the single element a visitor is supposed to *use*.
 *
 * Scripted, and it says so in three places rather than one. What is real: the module
 * names and pinned versions come from the catalogue snapshot; the diagram is the
 * product's own renderer over the product's own layout; the deploy checklist is the
 * real wizard's four setup stacks in the real order. What is invented: the example repo
 * and document names, and the timings. Nothing here talks to a model or to AWS, and
 * a demo that implied otherwise would undo the argument the rest of the page makes.
 */

/** How long each agent step lingers before the next appears, in ms. */
const STEP_INTERVAL_MS = 520;

/** And how long after the last step the result appears. */
const SETTLE_MS = 420;

/** The deploy checklist runs slower: real stacks, and CloudFormation is not quick. */
const DEPLOY_INTERVAL_MS = 700;

type StepId = 1 | 2 | 3;

const STEPS: { id: StepId; label: string; hint: string }[] = [
  { id: 1, label: "Identify", hint: "or describe the requirements" },
  { id: 2, label: "Generate", hint: "production-ready infrastructure" },
  { id: 3, label: "Deploy", hint: "with seamless cloud integration" },
];

/** Which of step one's three sources is open. */
type Source = "repo" | "doc" | "text";

const SOURCES: { id: Source; label: string; icon: typeof GitBranch }[] = [
  { id: "repo", label: "Application repository", icon: GitBranch },
  { id: "doc", label: "Documentation", icon: FileText },
  { id: "text", label: "Describe it", icon: MessageSquare },
];

/**
 * Which scenarios each source offers as its examples.
 *
 * Split rather than repeated, so the three tabs are three different things to look
 * at instead of the same four rows relabelled. Two repositories is enough to show
 * that the choice exists — a longer list of invented names reads as filler.
 */
const REPO_EXAMPLES = SCENARIOS.slice(0, 2);
const DOC_EXAMPLES = SCENARIOS.slice(2, 4);

export function DemoWizard() {
  const [step, setStep] = useState<StepId>(1);
  const [source, setSource] = useState<Source>("repo");
  const [scenario, setScenario] = useState<DemoScenario | null>(null);
  /**
   * Which scenario a rail jump should land on when nothing has been picked yet.
   *
   * The rail is navigable from the start rather than unlocking step by step. A
   * gated rail is right when the steps depend on each other, and here they only
   * appear to: this is a walk-through, and a reader who wants to see the
   * architecture before reading about repositories should not have to earn it.
   */
  const landing = scenario ?? DEFAULT_SCENARIO;

  /** Free-text input, and whether the last submission matched nothing. */
  const [input, setInput] = useState("");
  const [unmatched, setUnmatched] = useState(false);

  /** How many of the generate step's lines are on screen, and of the deploy step's. */
  const [built, setBuilt] = useState(0);
  const [deployed, setDeployed] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [deploying, setDeploying] = useState(false);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  }, []);

  // Nothing may outlive the component: a pending step would set state on an
  // unmounted tree, and a visitor who scrolls away mid-run does exactly that.
  useEffect(() => clearTimers, [clearTimers]);

  /** Runs the generate step's trail, then hands over to the result. */
  const generate = useCallback(
    (next: DemoScenario) => {
      clearTimers();
      setScenario(next);
      setUnmatched(false);
      setBuilt(0);
      setGenerating(true);
      setStep(2);

      next.steps.forEach((_, index) => {
        timers.current.push(
          setTimeout(() => setBuilt(index + 1), STEP_INTERVAL_MS * (index + 1)),
        );
      });
      timers.current.push(
        setTimeout(
          () => setGenerating(false),
          STEP_INTERVAL_MS * next.steps.length + SETTLE_MS,
        ),
      );
    },
    [clearTimers],
  );

  /** And the deploy step's, which is the same shape over the checklist. */
  const deploy = useCallback(() => {
    clearTimers();
    setDeployed(0);
    setDeploying(true);
    setStep(3);

    DEPLOY_STEPS.forEach((_, index) => {
      timers.current.push(
        setTimeout(
          () => setDeployed(index + 1),
          DEPLOY_INTERVAL_MS * (index + 1),
        ),
      );
    });
    timers.current.push(
      setTimeout(
        () => setDeploying(false),
        DEPLOY_INTERVAL_MS * DEPLOY_STEPS.length + SETTLE_MS,
      ),
    );
  }, [clearTimers]);

  const submitText = useCallback(() => {
    const next = matchScenario(input);
    if (!next) {
      setUnmatched(true);
      return;
    }
    generate(next);
  }, [generate, input]);

  /**
   * A rail jump, which shows a step finished rather than replaying it.
   *
   * Navigating is not the same gesture as running: someone who clicks "Deploy" in
   * the rail is asking to see the deploy step, not to sit through the whole
   * checklist appearing. The animations belong to the forward buttons, where they are the
   * answer to something the reader just did.
   */
  const goTo = useCallback(
    (next: StepId) => {
      clearTimers();
      setGenerating(false);
      setDeploying(false);
      setUnmatched(false);
      if (!scenario) setScenario(DEFAULT_SCENARIO);
      setBuilt(landing.steps.length);
      setDeployed(DEPLOY_STEPS.length);
      setStep(next);
    },
    [clearTimers, landing.steps.length, scenario],
  );

  const restart = useCallback(() => {
    clearTimers();
    setStep(1);
    setSource("repo");
    setScenario(null);
    setInput("");
    setUnmatched(false);
    setBuilt(0);
    setDeployed(0);
    setGenerating(false);
    setDeploying(false);
  }, [clearTimers]);

  const busy = generating || deploying;

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <StepRail busy={busy} current={step} onGo={goTo} />

      <div className="min-h-[26rem] p-4 sm:p-5">
        {step === 1 ? (
          <SourceStep
            input={input}
            onInput={(value) => {
              setInput(value);
              setUnmatched(false);
            }}
            onPick={generate}
            onSource={setSource}
            onSubmitText={submitText}
            source={source}
            unmatched={unmatched}
          />
        ) : null}

        {step === 2 && scenario ? (
          <GenerateStep
            built={built}
            generating={generating}
            scenario={scenario}
          />
        ) : null}

        {step === 3 && scenario ? (
          <DeployStep deployed={deployed} deploying={deploying} />
        ) : null}
      </div>

      {/* Footer. Present from step two on, because step one's controls are its
          own content — a Next button there would need something selected first. */}
      {step > 1 ? (
        <div className="flex items-center gap-2 border-t bg-muted/20 px-4 py-3">
          <Button
            className="h-8 px-2.5 text-xs"
            disabled={busy}
            onClick={() => goTo(step === 3 ? 2 : 1)}
            size="sm"
            variant="ghost"
          >
            <ArrowLeft className="mr-1.5 h-3 w-3" />
            Back
          </Button>

          <Button
            className="h-8 px-2.5 text-xs"
            disabled={busy}
            onClick={restart}
            size="sm"
            variant="ghost"
          >
            <RotateCcw className="mr-1.5 h-3 w-3" />
            Start over
          </Button>

          {step === 2 ? (
            <Button
              className="ml-auto h-8"
              disabled={generating}
              onClick={deploy}
              size="sm"
            >
              Connect AWS and deploy
              <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The three steps, all of them navigable.
 *
 * Only the current one is not a button, because clicking where you already are is a
 * no-op that still looks like it should do something. The rest are live from the
 * start: this is a walk-through and every step has something to show, so gating them
 * would only make a reader work for material that is already there.
 */
function StepRail({
  busy,
  current,
  onGo,
}: {
  busy: boolean;
  current: StepId;
  onGo: (step: StepId) => void;
}) {
  return (
    <ol className="flex items-stretch border-b bg-muted/20">
      {STEPS.map((step, index) => {
        const state =
          step.id < current ? "done" : step.id === current ? "current" : "todo";
        const navigable = step.id !== current && !busy;

        const body = (
          <>
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[0.65rem] transition-colors duration-300 ${
                state === "done"
                  ? "border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-500"
                  : state === "current"
                    ? "border-foreground/25 bg-foreground text-background"
                    : "text-muted-foreground"
              }`}
            >
              {state === "done" ? (
                <Check aria-hidden className="h-3 w-3" />
              ) : (
                step.id
              )}
            </span>

            <span className="min-w-0 text-left">
              <span className="block truncate font-medium text-xs sm:text-sm">
                {step.label}
              </span>
              <span className="hidden truncate text-[0.7rem] text-muted-foreground sm:block">
                {step.hint}
              </span>
            </span>
          </>
        );

        return (
          <li
            aria-current={state === "current" ? "step" : undefined}
            className={`flex flex-1 ${index > 0 ? "border-l" : ""} ${
              state === "todo" ? "opacity-70" : ""
            }`}
            key={step.id}
          >
            {navigable ? (
              <button
                className="flex w-full items-center gap-2.5 px-3 py-3 transition-colors duration-200 hover:bg-muted/60 sm:px-4"
                onClick={() => onGo(step.id)}
                type="button"
              >
                {body}
              </button>
            ) : (
              <span className="flex w-full items-center gap-2.5 px-3 py-3 sm:px-4">
                {body}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Step one: the three places a requirement can come from.
 *
 * All three are the product's real context sources. Two of them cannot be wired up
 * on a static site — a repository picker needs an OAuth token and an upload needs
 * something to upload to — so they offer examples and say plainly that they are
 * examples. An input that looks live and does nothing would be a worse lie than a
 * labelled sample, and it is the sort a visitor discovers by trying.
 */
function SourceStep({
  input,
  onInput,
  onPick,
  onSource,
  onSubmitText,
  source,
  unmatched,
}: {
  input: string;
  onInput: (value: string) => void;
  onPick: (scenario: DemoScenario) => void;
  onSource: (source: Source) => void;
  onSubmitText: () => void;
  source: Source;
  unmatched: boolean;
}) {
  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {SOURCES.map((entry) => (
          <button
            aria-selected={source === entry.id}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors duration-200 ${
              source === entry.id
                ? "border-foreground/25 bg-foreground text-background"
                : "text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            }`}
            key={entry.id}
            onClick={() => onSource(entry.id)}
            role="tab"
            type="button"
          >
            <entry.icon aria-hidden className="h-3.5 w-3.5" />
            {entry.label}
          </button>
        ))}
      </div>

      {source === "repo" ? (
        <div className="fade-in mt-4 animate-in duration-300">
          <p className="text-muted-foreground text-xs leading-relaxed"></p>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2">
            {REPO_EXAMPLES.map((entry) => (
              <li key={entry.id}>
                <button
                  className="group flex w-full items-center gap-3 rounded-lg border bg-background p-3 text-left transition-colors duration-200 hover:border-foreground/30 hover:bg-muted/30"
                  onClick={() => onPick(entry)}
                  type="button"
                >
                  <GitBranch
                    aria-hidden
                    className="h-4 w-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-sm">
                      {entry.repo.name}
                    </span>
                    <span className="block truncate text-[0.7rem] text-muted-foreground">
                      {entry.repo.language}
                    </span>
                  </span>
                  <ArrowRight
                    aria-hidden
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors duration-200 group-hover:text-foreground"
                  />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {source === "doc" ? (
        <div className="fade-in mt-4 animate-in duration-300">
          <p className="text-muted-foreground text-xs leading-relaxed"></p>

          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {/* Upload. A dashed border because that is what a drop target looks
                like, and the caption says it is an example rather than one. */}
            <button
              className="group flex flex-col items-start gap-2 rounded-lg border border-dashed bg-background p-4 text-left transition-colors duration-200 hover:border-foreground/30 hover:bg-muted/30"
              onClick={() => onPick(DOC_EXAMPLES[0] as DemoScenario)}
              type="button"
            >
              <Upload
                aria-hidden
                className="h-4 w-4 text-muted-foreground transition-colors duration-200 group-hover:text-foreground"
              />
              <span className="font-medium text-sm">Upload a document</span>
              <span className="text-muted-foreground text-xs leading-snug">
                A design doc or a requirements brief. PDF, Word or Markdown.
              </span>
              <span className="mt-auto flex items-center gap-1.5 pt-2 font-mono text-[0.7rem] text-muted-foreground">
                <FileText aria-hidden className="h-3 w-3 shrink-0" />
                {DOC_EXAMPLES[0]?.doc.name}
              </span>
            </button>

            {/* MCP. A real capability, which is why it can be named plainly. */}
            <button
              className="group flex flex-col items-start gap-2 rounded-lg border bg-background p-4 text-left transition-colors duration-200 hover:border-foreground/30 hover:bg-muted/30"
              onClick={() => onPick(DOC_EXAMPLES[1] as DemoScenario)}
              type="button"
            >
              <Server
                aria-hidden
                className="h-4 w-4 text-muted-foreground transition-colors duration-200 group-hover:text-foreground"
              />
              <span className="font-medium text-sm">Connect it over MCP</span>
              <span className="text-muted-foreground text-xs leading-snug">
                Your wiki or tracker, through a server you run. Tools are
                enabled one by one.
              </span>
              <span className="mt-auto flex items-center gap-1.5 pt-2 font-mono text-[0.7rem] text-muted-foreground">
                <Server aria-hidden className="h-3 w-3 shrink-0" />
                confluence · architecture space
              </span>
            </button>
          </div>
        </div>
      ) : null}

      {source === "text" ? (
        <div className="fade-in mt-4 animate-in duration-300">
          {/* `items-start` rather than `items-end`: the button is pinned to the top
              of the box, level with the first line of the placeholder. With
              `items-end` it sat against the bottom edge and drifted downwards as the
              textarea grew, so it was never aligned with anything — and on a
              two-line box it read as though it belonged to the second line.
              `focus-within` moves the ring to the wrapper, which is what makes the
              border and the textarea look like one control instead of two. */}
          <div className="flex items-start gap-2 rounded-lg border bg-background p-2 transition-colors duration-200 focus-within:border-foreground/30">
            <textarea
              aria-label="Describe the infrastructure you need"
              className="min-h-9 min-w-0 flex-1 resize-none border-0 bg-transparent px-2 py-1.5 text-sm leading-6 outline-none placeholder:text-muted-foreground"
              onChange={(event) => onInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (input.trim()) onSubmitText();
                }
              }}
              placeholder="“a containerised API with a Postgres database”"
              rows={2}
              value={input}
            />
            {/* h-9 w-9 to match the textarea's first line box, so the two are
                optically level rather than merely both present. */}
            <Button
              aria-label="Generate"
              className="h-9 w-9 shrink-0"
              disabled={input.trim().length === 0}
              onClick={onSubmitText}
              size="icon"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>

          {/* The keyboard affordance, which the box had no way of telling anyone
              about — Enter submits and Shift+Enter does not, and both were silent. */}
          <p className="mt-1.5 px-2 text-[0.7rem] text-muted-foreground">
            Press{" "}
            <kbd className="rounded border bg-muted/50 px-1 font-mono text-[0.65rem]">
              Enter
            </kbd>{" "}
            to generate,{" "}
            <kbd className="rounded border bg-muted/50 px-1 font-mono text-[0.65rem]">
              Shift
            </kbd>{" "}
            +{" "}
            <kbd className="rounded border bg-muted/50 px-1 font-mono text-[0.65rem]">
              Enter
            </kbd>{" "}
            for a new line.
          </p>

          {unmatched ? (
            <Unmatched onPick={onPick} />
          ) : (
            /* Each chip runs its scenario rather than filling the box and
               waiting. Dropping text into a field and stopping there reads as a
               dead control — you click, something changes, and nothing happens. */
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs">Try:</span>
              {SCENARIOS.map((entry) => (
                <button
                  className="rounded-full border px-2.5 py-1 text-muted-foreground text-xs transition-colors duration-200 hover:border-foreground/30 hover:text-foreground"
                  key={entry.id}
                  onClick={() => onPick(entry)}
                  type="button"
                >
                  {entry.title.toLowerCase()}
                </button>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * What a visitor sees when their sentence matches no script.
 *
 * Written to be worth reading rather than to apologise. The limitation is the
 * demo's, not the product's, and the distinction is the whole point: the page can
 * either claim the agent refuses to guess or it can refuse in front of you. The
 * second is cheaper to believe.
 */
function Unmatched({ onPick }: { onPick: (scenario: DemoScenario) => void }) {
  return (
    <div className="fade-in mt-3 animate-in duration-300">
      <div className="flex gap-3 rounded-lg border border-dashed bg-muted/20 p-3.5">
        <HelpCircle
          aria-hidden
          className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
        />
        <div>
          <p className="font-medium text-sm">No script for that one</p>
          <p className="mt-1 text-muted-foreground text-sm leading-relaxed">
            This walk-through has four prepared answers and yours is not among
            them, so it is not going to improvise a stack. Neither would the
            real agent: it looks a module up before wiring it, and records what
            it could not resolve instead of inventing an input name that only
            fails once somebody runs Terraform.
          </p>
        </div>
      </div>

      <ul className="mt-3 grid gap-2">
        {SCENARIOS.map((entry) => (
          <li key={entry.id}>
            <button
              className="group flex w-full items-center gap-3 rounded-lg border bg-background p-3 text-left transition-colors duration-200 hover:border-foreground/30"
              onClick={() => onPick(entry)}
              type="button"
            >
              <span className="flex-1 text-sm leading-snug">
                {entry.prompt}
              </span>
              <CornerDownLeft
                aria-hidden
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors duration-200 group-hover:text-foreground"
              />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Step two: the turn, then what it produced. */
function GenerateStep({
  built,
  generating,
  scenario,
}: {
  built: number;
  generating: boolean;
  scenario: DemoScenario;
}) {
  return (
    <div className="space-y-4">
      <ol className="space-y-1.5">
        {scenario.steps.slice(0, built).map((step, index) => (
          <li
            className="fade-in slide-in-from-bottom-1 flex animate-in items-start gap-2 text-sm duration-300"
            key={step}
          >
            {index === built - 1 && generating ? (
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
            )}
            <span className="font-mono text-muted-foreground text-xs leading-relaxed">
              {step}
            </span>
          </li>
        ))}
      </ol>

      {generating ? null : (
        <div className="fade-in animate-in duration-500">
          <Architecture scenario={scenario} />
        </div>
      )}
    </div>
  );
}

/**
 * Step three: the deployment wizard, in order, ending in the apply.
 *
 * Just the checklist. It used to be followed by a plan summary — module and resource
 * counts in a bordered panel — and two paragraphs of prose. The counts were the
 * weakest thing on the page: numbers a reader cannot check, next to a diagram they
 * can, which invites exactly the comparison the demo does not survive. The apply is
 * now the last row of the list instead, which says the same thing in three words.
 */
function DeployStep({
  deployed,
  deploying,
}: {
  deployed: number;
  deploying: boolean;
}) {
  return (
    <div className="space-y-4">
      <ol className="space-y-2">
        {DEPLOY_STEPS.map((entry, index) => {
          const state =
            index < deployed
              ? "done"
              : index === deployed && deploying
                ? "running"
                : "todo";

          return (
            <li
              className={`flex items-start gap-3 rounded-lg border p-3 transition-opacity duration-300 ${
                state === "todo" ? "opacity-45" : ""
              }`}
              key={entry.label}
            >
              {state === "done" ? (
                <Check
                  aria-hidden
                  className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
                />
              ) : state === "running" ? (
                <Loader2
                  aria-hidden
                  className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground"
                />
              ) : (
                <span
                  aria-hidden
                  className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full border"
                />
              )}
              <div className="min-w-0">
                <p className="font-medium text-sm leading-snug">
                  {entry.label}
                </p>
                {state === "done" ? (
                  <p className="fade-in mt-0.5 animate-in text-muted-foreground text-xs leading-relaxed duration-300">
                    {entry.detail}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The product's architecture diagram, over this scenario's graph.
 *
 * Same renderer and same layout function as the project page — see `demo-graphs.ts`
 * for what is real here and what is authored. A fixed height because the canvas has
 * no content-driven size of its own; `fill` makes it take the parent's.
 */
function Architecture({ scenario }: { scenario: DemoScenario }) {
  const { nodes, edges } = useMemo(
    () => diagramFor(scenario.id),
    [scenario.id],
  );

  return (
    <div className="h-[24rem] overflow-hidden rounded-lg border bg-muted/20 sm:h-[28rem]">
      <ArchitectureDiagram
        edges={edges}
        fill
        iconBasePath="/aws-icons"
        key={scenario.id}
        nodes={nodes}
      />
    </div>
  );
}
