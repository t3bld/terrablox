# @terrablox/agent-harness

What the agent harness is made of, what it may do, and which dials it has.

Four modules of data. No model is called here, no session is created, nothing is stored —
this package is the *description* of the harness that `lib/agent/project-agent.ts` runs.

## Why a description deserves a package

Because three different surfaces read it, and they must not disagree.

The harness screen draws a diagram from `harness-model`, and every box in it has to match a
settings control. The admin panel edits the text of those same entries. The agent itself
reads `tool-catalogue` to decide which operations to register and `runtime-options` for the
budgets it enforces. When a fourth reader appears — a documentation page, a CLI that prints
what an agent is allowed to do — it should not have to import the Copilot SDK to find out.

That is also the honest limit of this package: it is worth extracting because it is *read
from many places*, not because it is reusable in the abstract. The set is closed, which is
what made it cheap: these four modules import each other and nothing else at all.

| Entry point | Answers |
| --- | --- |
| `./harness-model` | Which planes the harness has, what sits on each, and which setting governs it |
| `./tool-catalogue` | Every operation the agent can be given, with its label and its group |
| `./runtime-options` | The dials — timeouts, budgets, the models offered — with their bounds |
| `./knowledge` | The sources a turn may be given, by id |

## The one rule worth knowing

`runtime-options` holds the *defaults and bounds*, and nothing that reads a user's choice.
That separation is load-bearing: the settings service validates against these bounds, the
agent enforces the resolved value, and the screen renders both. A default that lived next to
the code that stores it would be a second copy — and the bounds and the default drifted
exactly once before this split, when the recorded step trail sat at 40 entries while the
operation budget had been raised to 100. `runtime-options.test.ts` now asserts that every
default lies inside its own bounds, and that a turn spending every budget still fits in the
trail that records it.
