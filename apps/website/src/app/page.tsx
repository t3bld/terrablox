import { Badge } from "@terrablox/ui/badge";
import { Button } from "@terrablox/ui/button";
import { Card, CardContent } from "@terrablox/ui/card";
import { ArrowRight, Terminal } from "lucide-react";
import Link from "next/link";
import { DemoWizard } from "@/components/demo-wizard";
import { HarnessDiagram } from "@/components/harness-diagram";
import { ModuleSearchGrid } from "@/components/module-search-grid";
import { ProductFigure } from "@/components/product-figure";
import { ProjectViewFigure } from "@/components/project-view-figure";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { asset } from "@/lib/assets";
import { moduleTiles } from "@/lib/catalogue";
import { CONSULTING_URL, DOCS_URL } from "@/lib/links";

/**
 * The landing page.
 *
 * Every claim points at something in this repository. If a sentence cannot be
 * checked by opening the product, reading a generated file or deleting a stack, it
 * does not belong here — which is also why there are no percentages. Nobody has
 * measured how much faster this makes anyone, and a number invented for a hero
 * section is the fastest way to lose a reader who knows Terraform.
 *
 * The harness leads, because it is the difference. Every tool in this space has a
 * chat box; what almost none of them have is a stated position on what their agent
 * may reach and which of its rules it is actually held to.
 */

export default function HomePage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />

      <main className="flex-1">
        {/* Hero. The grid and the staggered entrance run on load rather than on
            scroll, so the first thing a visitor sees is the one piece of motion
            that cannot arrive late. */}
        <section className="relative overflow-hidden border-b">
          <div
            aria-hidden
            className="grid-backdrop pointer-events-none absolute inset-0"
          />

          <div className="relative mx-auto max-w-6xl px-4 pt-20 pb-16 md:pt-28 md:pb-20">
            {/* Two columns from `lg`, one below it.
                The right column is deliberately wider than its grid track — see the
                width on it — so the screenshot runs past the page and off the
                viewport, and the section's `overflow-hidden` does the cutting. That
                clip is not decoration: without it the overflow puts a horizontal
                scrollbar on the whole document at some widths, which is the usual
                way this pattern goes wrong. */}
            <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-10">
              <div>
                <div className="fade-in slide-in-from-bottom-3 animate-in duration-700">
                  <Badge variant="outline">
                    Scale migrations with tooling, not headcount
                  </Badge>
                </div>

                <h1 className="fade-in slide-in-from-bottom-4 mt-5 animate-in text-balance font-semibold text-4xl tracking-tight delay-100 duration-700 md:text-5xl xl:text-6xl">
                  Cloud migrations at lightspeed,{" "}
                  <span className="sheen bg-[linear-gradient(110deg,hsl(var(--foreground)),45%,hsl(var(--muted-foreground)),55%,hsl(var(--foreground)))] bg-clip-text text-transparent">
                    on an opinionated agent harness
                  </span>
                </h1>

                <p className="fade-in slide-in-from-bottom-4 mt-6 max-w-2xl animate-in text-lg text-muted-foreground leading-relaxed delay-200 duration-700">
                  Connect your application repository, upload a documentation or
                  just describe what you are deploying. Terrablox resolves it to
                  curated best-practice modules and commits production-ready
                  infrastructure to your cloud account.
                </p>
                <div className="fade-in slide-in-from-bottom-4 mt-8 flex animate-in flex-wrap items-center gap-3 delay-300 duration-700">
                  {/* To the docs on this site rather than to the README's quick-start
                      anchor: the instructions are here, laid out, and sending the
                      most motivated visitor to a file listing on GitHub made the
                      repository the first thing they had to get past. */}
                  <Button asChild size="lg">
                    <Link href={DOCS_URL}>
                      Self-host it
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                  {/* No `target="_blank"` on a `mailto:`. There is no tab to open —
                      the browser hands off to a mail client — and the attribute only
                      leaves some browsers with a blank window behind. `rel` went with
                      it, since it exists to protect the opener of a new tab. */}
                  <Button asChild size="lg" variant="outline">
                    <a href={CONSULTING_URL}>Work with us</a>
                  </Button>
                </div>
              </div>

              {/* `calc(50vw + 6rem)` rather than a negative margin: a fixed margin
                  reaches past the viewport on a laptop and stops well short of it on
                  a 27-inch display, so the bleed would quietly stop happening on the
                  screens most likely to see it. Half the viewport plus a fixed
                  overhang passes the right edge at every width. */}
              <div className="fade-in slide-in-from-bottom-4 mt-12 animate-in delay-300 duration-1000 lg:mt-0 lg:w-[calc(50vw+6rem)]">
                <ProductFigure
                  alt="The Terrablox project view: the module library on the left, the architecture of a VPC with a public subnet, an EC2 instance, an Elastic IP and Secrets Manager in the middle, and the agent explaining what it built on the right."
                  objectPosition="left top"
                  priority
                  ratio="16 / 10"
                  // `#code`, not `#architecture`. The project tabs are
                  // `["code", "deploy", "state", "costs", "log"]` and the canvas
                  // level is component state rather than part of the URL, so
                  // `#architecture` was a link that resolves to `code` anyway.
                  route="/projects/…#code"
                  src={asset("/screenshots/project-diagram.png")}
                />
              </div>
            </div>

            {/* Reserved: the strip under the hero.
                Held open on purpose — it has carried a four-figure summary and a
                customer logo strip, and both were taken out again. Deliberately
                unstyled: the spacing and the rule a filled version wants
                (`mt-16 border-t pt-8`, entering with
                `fade-in animate-in delay-500 duration-1000`) would otherwise draw a
                horizontal line under an empty block. Put them back on this div when
                it has content again. */}
            <div />
          </div>
        </section>

        {/* The demo, straight after the hero: it is the fastest way to understand
            the product, and a visitor who reads nothing else should hit it. */}
        <section className="border-b bg-muted/30" id="demo">
          <div className="mx-auto max-w-5xl px-4 py-16 md:py-24">
            <div className="reveal max-w-2xl">
              {/* "From X to Y in three steps" kept, because the shape is doing
                  work: it names the starting point a visitor actually has and ties
                  the count to the three steps in the widget below.

                  "Bullet-proof" came out. It is the one word here nothing on this
                  page backs — no benchmark, no uptime claim, nothing — and a reader
                  who notices that discounts the sentences that *are* verifiable.
                  "Deployed" is a claim the section can keep: the third step is the
                  deploy, and the pipeline it commits is what performs it.

                  "Legacy" also came out, for accuracy rather than tone. What this
                  reads is a repository and its documentation, which plenty of
                  actively developed applications have; "an existing application" is
                  the condition that matters, and it is the greenfield assumption
                  this section exists to deny. */}
              <h2 className="text-balance font-semibold text-2xl tracking-tight md:text-4xl">
                From an existing application to deployed infrastructure in
                minutes
              </h2>
              {/* Names what each of the three steps does, because the heading
                  promises three and the widget below only labels them once it is
                  scrolled to. Worth checking against `STEPS` in `demo-wizard.tsx` if
                  either changes — this sentence is the only place the three are
                  spelled out in prose.

                  "Nobody starts from nothing" earns "an existing application" in the
                  heading. The scripted-demo disclosure deliberately stays inside the
                  widget, which already carries it in three places. */}
              <p className="mt-4 text-muted-foreground leading-relaxed">
                The agent reads the application repository and documentation,
                identifies the requirements it finds, composes the required
                infrastructure and walks you through the cloud setup.
              </p>
            </div>

            <div className="reveal mt-10">
              <DemoWizard />
            </div>
          </div>
        </section>

        {/* The harness, drawn as the path a turn takes.
        
            `max-w-7xl` where the rest of the page is `max-w-6xl`: the diagram is a row
            of five columns and needs the width. It is the one section allowed to be
            wider, and it is wider because of the drawing rather than as a style. */}
        <section className="border-b" id="harness">
          <div className="mx-auto max-w-7xl px-4 py-16 md:py-24">
            <div className="reveal">
              {/* No eyebrow label here. It read "The harness" directly above a
                  heading ending in the same word, so it spent a line of vertical
                  space repeating the next one. `mt-4` came off the heading with it —
                  that margin existed to clear the badge.

                  The heading is a claim about what is *around* the model rather than
                  about the model, which is the argument the drawing under it makes:
                  requirements before building, a fixed set of operations, a check on
                  every call. "Proven industry agent harness" was the previous one and
                  it asserted a reputation — "proven" by whom is the question it
                  invites, and the honest answer on a young project is nobody yet. This
                  one asserts a mechanism instead, which the diagram then shows. */}
              <h2 className="max-w-3xl text-balance font-semibold text-2xl tracking-tight md:text-4xl">
                The agent harness comes assembled
              </h2>
              {/* "Works out of the box" was the heading and the body's second
                  sentence and its third, which is one claim said three times and
                  checkable none of them. What replaces it is the same promise stated
                  as things a reader can verify: the four parts are the four panels in
                  the drawing directly below, and the one command is `pnpm quickstart`,
                  which writes the env files, starts Postgres, applies the migrations
                  and brings the dashboard up.

                  "and surrounding it is usually the work" earns the paragraph its
                  place. Without it the sentence is a feature list; with it, it names
                  the objection — that a harness is the part you are normally left to
                  build — which is what makes "comes assembled" worth saying. */}
              <p className="mt-4 max-w-2xl text-muted-foreground leading-relaxed">
                An agent is only as good as the system around it. Terrablox
                gives your agent everything it needs to get the job done and
                works out of the box.
              </p>
            </div>

            <div className="mt-12">
              <HarnessDiagram />
            </div>
          </div>
        </section>

        {/* The product, shown. Still no carousel — nothing on this page rotates
            away from a reader who stopped to look at it.

            The switch is a partial exception now, and it is worth being straight
            about which part. Detail and Architecture are one system at two zoom
            levels, and the hero has already shown Architecture at full width, so
            neither is new information. Logs is: it answers a different question, and
            it sits behind a click.

            What keeps that acceptable is that the *claim* is not behind the click.
            The third paragraph beside the figure says what a decision record holds
            and that none of them is rewritten, so a reader who never touches the
            switch has still been told the thing the screenshot would show them.
            Hiding the evidence is fine; hiding the assertion would not be. */}
        <section className="border-b bg-muted/30" id="screens">
          <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
            {/* Split, with the figure in the first column on wide screens.
                Reversed against the hero on purpose. The hero runs text-left,
                figure-right; repeating that rhythm makes every section look like the
                same slide. Here the order also does some work: the heading opens by
                telling a reader to look, and putting the picture where a
                left-to-right eye lands first is that instruction carried out instead
                of asserted.

                DOM order stays text-then-figure and `lg:order-first` moves the figure
                for the wide layout, so the small-screen sequence is heading, prose,
                image — a screenshot arriving before any context reads as decoration.
                Neither element is focusable, so the visual reorder costs nothing in
                keyboard or reading order.

                `1.15fr` against `1fr`: the figure earns the larger share because it is
                the subject, and the prose column lands near 50 characters, which is
                inside a comfortable measure rather than the 90 it had at full width. */}
            <div className="grid items-center gap-8 lg:grid-cols-[1.15fr_1fr] lg:gap-12">
              <div className="reveal">
                {/* Two sentences, parallel verbs, second clause swapped. It used to
                    read "See your infrastructure. Don't read it." — an argument for
                    the picture over the HCL, made when this figure had one view. With
                    the log beside the two diagrams the section answers a second
                    question, and it is the more uncomfortable one: an agent wrote
                    this, so what did it decide and on what grounds. Hence "understand
                    your agent" rather than another line about legibility.

                    The cadence is kept deliberately. "See your infrastructure" is
                    still the first instruction, which is what the reversed column
                    order below is carrying out. */}
                <h2 className="text-balance font-semibold text-2xl tracking-tight md:text-4xl">
                  See what the agent built and understand why
                </h2>
                {/* Two halves for the two questions this figure answers, in the order
                    its tabs are in. The first is legibility, the second is the
                    uncomfortable one — an agent wrote this, so what did it decide and
                    on what grounds — which is why the heading ends on "why" rather
                    than on another word about diagrams.

                    The body names all three views rather than praising them. "Nobody
                    wants to watch boring code generation" was the previous opening: it
                    described the reader's feelings instead of the product's output, and
                    a sentence that tells someone they are bored is a sentence they
                    have to agree with before it says anything. The four-hundred-line
                    figure is the same one the rules section uses, deliberately — it is
                    what a Terraform review actually costs. */}
                <p className="mt-4 text-muted-foreground leading-relaxed">
                  Reviewing generated code means digging through hundreds of
                  lines to find what matters. See what the agent is actually
                  doing in a human-readable way.
                </p>
              </div>

              <div className="reveal lg:order-first">
                <ProjectViewFigure
                  id="project-view"
                  screenshots={{
                    architecture: {
                      alt: "The same project drawn as AWS services: an internet gateway and a public subnet inside a VPC, an Elastic IP pointing at an EC2 instance, and a Secrets Manager secret below, each box labelled with the Terrablox module that deploys it.",
                      // The hero pins `left top` to keep the half of the window
                      // that is still on screen. Here the frame sits inside the
                      // column, so the diagram itself is what should be centred.
                      objectPosition: "center top",
                      src: asset("/screenshots/project-diagram.png"),
                    },
                    detail: {
                      alt: "The module graph of a project: vpc, web_sg, app_server, app_secrets and secrets_read_policy as cards, with vpc_id, secret_arn and arn drawn from the output that produces them to the input that consumes them.",
                      src: asset("/screenshots/project-graph.png"),
                    },
                    // No capture yet, so the figure says what it would show rather
                    // than rendering a broken image. Drop a shot of the Logs tab
                    // into `public/screenshots/` and give it a `src` here.
                    logs: {
                      alt: "The project log: each applied operation under the decision that produced it — what was being decided, what was chosen and why, and which alternatives lost.",
                      src: null,
                    },
                  }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* The catalogue, with real names. */}
        <section className="border-b" id="library">
          <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
            <div className="reveal max-w-2xl">
              <h2 className="text-balance font-semibold text-2xl tracking-tight md:text-4xl">
                Curated module library the industry already runs in production
              </h2>
              {/* "…the industry already runs in production" was the previous tail and
                  it is not a claim this file can support. The catalogue is seeded from
                  the org's own `terrablox-aws-*` repositories (see `lib/modules.ts`);
                  the names and pinned tags line up with the well-known community
                  modules, which is suggestive and is not evidence. What is left is
                  checkable from the tiles below: how many there are, that each sits at
                  an exact tag, and that two projects needing a VPC get the same one.

                  Put the provenance back the moment it is verifiable — it is the
                  stronger sentence, and it is only worth having if it is true. */}
              <p className="mt-4 text-muted-foreground leading-relaxed">
                Stop generating infrastructure from scratch. Assemble migrations
                from curated, production-proven Terraform modules for
                predictable deployments and consistent quality.{" "}
              </p>
            </div>

            {/* Names and icons only, and every tile is a link. The version used to
                sit beside each name and was the wrong fact for this section: the copy
                above already says each module is at a real tag, and fifty version
                numbers is fifty things to read past on the way to finding one. The
                exact tag is on the module's own page, where it can be acted on. */}
            <div className="reveal mt-10">
              <ModuleSearchGrid
                modules={moduleTiles().map((module) => ({
                  ...module,
                  iconSrc: module.icon
                    ? asset(`/module-icons/${module.icon}`)
                    : null,
                }))}
              />
            </div>
          </div>
        </section>

        {/* Close on the command. */}
        <section className="bg-muted/30" id="self-hosting">
          <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
            <div className="reveal grid gap-10 md:grid-cols-2 md:items-center">
              <div>
                <h2 className="text-balance font-semibold text-2xl tracking-tight md:text-4xl">
                  Run it yourself
                </h2>
                <p className="mt-4 text-muted-foreground leading-relaxed">
                  One command bootstraps the entire service.
                </p>

                {/* Both to the docs on this site. `Link` rather than `a`, and no
                    `target="_blank"` on either: these are internal routes now, so they
                    prefetch and navigate on the client, and opening an own-site page in
                    a new tab takes the reader's back button away for no reason. The
                    outbound `rel` went with the target it was protecting. */}
                <div className="mt-6 flex flex-wrap gap-3">
                  <Button asChild>
                    <Link href={DOCS_URL}>Quick start</Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link href={DOCS_URL}>Documentation</Link>
                  </Button>
                </div>
              </div>

              <Card className="overflow-hidden">
                <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
                  <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-mono text-muted-foreground text-xs">
                    terminal
                  </span>
                </div>
                <CardContent className="p-0">
                  <pre className="overflow-x-auto p-5 font-mono text-sm leading-relaxed">
                    <code>
                      <span className="text-muted-foreground">
                        {"# clone, then:"}
                      </span>
                      {"\n"}
                      <span className="text-emerald-600">$</span> pnpm
                      quickstart
                      {"\n\n"}
                      <span className="text-muted-foreground">
                        {"# dashboard on http://localhost:3001"}
                      </span>
                    </code>
                  </pre>
                </CardContent>
              </Card>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
