# Testing Notes

Rules for writing tests in this repo, written down so they don't have to be
relearned by hitting the same flaky failure twice. Grounded in this suite's
actual history — every anti-pattern below is a real thing this file used to
do.

## The one rule

**Every assertion must answer a question nothing else in the test already
answers.** Before adding an assertion, ask: if I deleted this line, would
the test still fail on the bug I'm guarding against? If yes, delete it.

The clearest violation this suite had:

```ts
// BAD — asked the model to phrase a number, then regex-matched its prose.
// Redundant (the next line already proves it) and the actual source of
// three separate flaky-CI failures this project has hit.
assert.match(r.stdout.trim(), /^1$/m);
const s = readState(tmpDir, "t1");
assert.strictEqual(s?.subscriptions?.length ?? 0, 0);
```

The state check is the real assertion — it reads the durable, structured
side effect. The stdout check adds no coverage (nothing fails the state
check that passes the stdout check, or vice versa, in any scenario that
matters) and adds a failure mode: the model can say "1." or "one" or "The
event fired and 1 subscriber was notified" and be _correct_ while failing
a strict regex. Delete assertions like this; don't loosen them.

## Pick a layer before you write the test

Three layers exist in this suite. Default to the cheapest one that can
actually prove the behavior.

| Layer                              | What it proves                                                                                                                    | How                                                                                 | Cost                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Unit** (`describe("unit: ...")`) | Deterministic extension logic: state transitions, obligation/barrier correlation, dedup, file writes, error handling              | `makeHarness()` — stub `pi`, no subprocess, call `store`/`inbox` functions directly | ~1ms                                                                       |
| **E2E** (everything else today)    | The model, given only the system prompt and a natural-language ask, discovers and correctly invokes the right tool                | Real `pi` subprocess, real model call via `runPi()`                                 | 5–25s + API cost                                                           |
| **Eval** (doesn't exist yet)       | Aggregate model judgment quality across ambiguous phrasings (e.g. "does the model pick Brief vs Note correctly ≥80% of the time") | N-sample runs, pass-rate threshold                                                  | expensive; only worth building if `system-prompt.ts` starts changing often |

Decision test: **does this test's outcome depend on what the model decides,
or only on what happens after some tool gets called with some params?**

- If the test would pass identically no matter which specific correctly-shaped
  tool call triggered it, it's testing deterministic logic → **unit test**,
  drive `inbox.sendCrossThread`/`deliver`/`drainInbox`/`checkDeadlines`
  directly against a `makeHarness()` store. See
  `describe("unit: inbox delivery")` for the pattern.
- If the test exists to prove the model actually _finds_ the right tool from
  ambiguous English (e.g. "tell your parent you're stuck" → `Blocker`), that's
  the one thing only a live model call can prove → **E2E**, and keep it.

Most of `cross-thread messaging` and `protocol: envelope, broadcast, blocker,
barrier` today are E2E tests of the second kind's _cost_ but the first kind's
_content_ — the prompts spell out the exact tool call
(`Call thread_send with to="alice", type="Brief", body="task A"`), so there's
no ambiguity left for the model to resolve. That's a known debt, not a
model to copy for new tests: new tests for deterministic follow-through
(does a matching Result clear the obligation, does a barrier dedup, does a
stale lock get dropped) belong at the unit layer.

## Regression discipline

Every real bug becomes a permanent test at the cheapest layer that can
express it — not a fix-and-forget. The barrier double-message bug and the
`wait=true`-on-Note gap both became unit tests the same session they were
found; that's the pattern to keep.

## Assertion shapes that are flaky by construction

Anything that depends on the model's exact word choice, phrasing, ordering
of free text, or verbatim number formatting is a flakiness risk _by
construction_ — not a bug in the test, an inherent property of asserting on
LLM prose. Rules of thumb:

- Never make free-text output the _only_ check for a behavior. If you want
  a stdout sanity signal in an E2E test, keep it loose (`assert.ok(r.ok)`,
  or a substring match for a concept, not an exact regex for a full
  answer) and back it with the structured check.
- If you're tempted to write `assert.match(stdout, /^exact-phrase$/)`,
  that's usually a sign the thing you actually care about is already
  observable in `state.json` or a written file — assert on that instead.

## Test behavior, not implementation

Assert what a caller actually depends on (obligation cleared, exactly one
message sent, barrier's `pending` list emptied) — not incidental internals
(exact internal id formatting beyond its documented prefix contract, array
iteration order that isn't part of any contract). If an assertion would
need to change every time an unrelated refactor touches internals without
changing behavior, it's testing the wrong thing.

## Negative paths aren't optional

Every unit test added for a happy path should prompt the question: what's
the adjacent error path? Malformed inbox JSON, `thread_send` to an unknown
id, answering the same `requestId` twice, arming two barriers on the same
id — these are cheap to add once `makeHarness()` exists for a given
function and are currently under-covered. Don't wait for a production
failure to add them if the harness is already there.

## One test, one reason to fail

Name tests after the guaranteed behavior ("Brief creates an obligation
that a matching Result clears" — good, keep naming this way), and keep
each test's assertions traceable to that one behavior. If a test can fail
for two unrelated reasons, split it — a red CI run should tell you what
broke without opening the test body.

## Fixture hygiene

Keep the existing `beforeEach`/`afterEach` + `mkdtempSync`/`rmSync`
per-test tmpDir isolation. No shared mutable state between tests, no test
that only fails when run after another one. This is already done right in
this file — don't erode it when adding tests.

## Before adding a new E2E test

Each one costs real wall-clock time and API spend and is a standing
flakiness liability. Check first: is there already an E2E test proving the
model can find _this_ tool from ambiguous language? If yes, the new
scenario is probably about what happens _after_ the tool call — that's a
unit test.
