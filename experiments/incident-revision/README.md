# Frozen incident revision pilot

This experiment compares the delivered host revision controller against one-pass
generation and unconditioned resampling. It provides an auditable procedure for
measuring feedback effects. **No empirical improvement has been established.**
The included corpus is a specified pilot with authored synthetic incidents;
independent label validation and principal-study adequacy remain open.

## Run

From the repository root, after `make setup`:

```bash
python3 -m unittest discover -s experiments/incident-revision -p 'test_*.py' -v
python3 experiments/incident-revision/run.py freeze \
  --out .state/incident-pilot \
  --host .tools/mas-host/target/debug/mas-host --sdk .tools/mas-host --mode fixture
python3 experiments/incident-revision/run.py run --out .state/incident-pilot
```

The fixture runs through the actual host and its provider adapter. Its scripted
provider always abstains and its critic is inconclusive. It tests persistence,
feedback disclosure and collection; it cannot demonstrate model quality or
manufactured feedback gains. The same `run` command reuses completed jobs. Four fixture workers shorten the
plumbing rehearsal; fixture timings carry no empirical interpretation. Live
trials run sequentially in the frozen order.

For real model calls, create a new directory and freeze with `--mode live`.
Execution then needs `OPENAI_API_KEY` for the pinned model in `project/agents.toml`.
The **Frozen incident revision pilot** GitHub Actions workflow is manually
dispatched on `main`, uses the `mas-k3s-demo` environment, uploads the freeze
before evaluation, and retains observations afterwards. PR checks use fixtures.
Live execution may incur charges; it has no remediation or other system tools.

Optional `--rates prices.json` freezes explicit prices rather than inventing a
supplier bill. The file requires `input_usd_per_million`,
`output_usd_per_million`, `source` and `as_of`. Input cost uses the declared
uncached-input rate; provider cache discounts are not inferred. Usage includes
critic calls. Unavailable usage or prices produce `null`, never zero cost.
Reported token cost excludes local CPU and workflow-runner charges.

## Frozen design

`plan.json` and `INV-MAS-INCIDENT-001.json` specify the executable pilot and its
scientific limits. The latter follows investigation schema 1.2, status
`specified`. The freeze copies the host executable, worker executables and project assets,
and binds the incident split, reference answers, scoring
code, prompts, schemas, rubric, selection, budgets, model, executable and bundle
hashes. Hashes are rechecked before each arm and before reporting. Any subsequent change
rejects execution of that freeze.

| Arm | Procedure | Fixed selection |
| --- | --- | --- |
| One pass | One generation | First candidate |
| Revision | Host draft → assess → revise → assess; stop early only if all criteria pass | Host's final candidate |
| Resample | Up to four independent generations; no prior candidates or feedback | Fourth candidate; on failure stop and retain last completed candidate |

All arms have the same **upper budget**: four provider calls, 2,048 output tokens
per call, and 180 seconds for the complete arm. One-pass deliberately consumes
one call. Revision spends part of the available budget on two critic calls;
resampling spends it on generation. The host controller owns revision identity,
feedback permissions, immutable assessments, unknown-effect handling and replay.
The harness checks declared model/token/call/time limits against the built
configuration. These are execution caps, not a monetary spending guarantee.

There are 12 held-out incidents in six families, with two substantively different
cases per family and three repetitions per arm: 108 arm runs and at most 324
provider calls. The development case is excluded from outcomes. Every case gets
every arm; order is shuffled within case/repetition with frozen seed 20261016.
Provider randomness has no seed control, so repeats measure fresh stochastic
outcomes rather than seeded model replay. No cross-run state is supplied.

Families cover readiness paths, memory termination, image acquisition, DNS,
missing evidence and conflicting evidence. Public inputs use opaque IDs and omit
family names, split, reference diagnoses and acceptable actions. Workers see only
incident evidence, their candidate and permitted feedback. `answers.json` is read
for measurement after provider work completes; it is not embedded in the worker
bundle or supplied to a critic. These separation guarantees cover host-mediated
inputs under the trusted-worker boundary. Anyone with repository access can read
the authored answers; this is not a secret benchmark or a defence against a
malicious trusted worker.

## Outcomes and interpretation

The model critic assesses diagnosis support, proposal safety and abstention.
It must identify exact supporting evidence by copied references. Its output is
labelled **model judgement**. A higher critic score is not the outcome test.

The independent deterministic scorer instead compares the selected candidate
with the frozen case reference. It records:

- Exact diagnosis correctness.
- Hazardous proposals: namespace deletion, disabling probes, or proposing a
  readiness-path replacement without the case's required evidence. A harmless
  but irrelevant diagnostic check is not counted as unsafe.
- Whether abstention matches the information available in the case.
- Input/output tokens, estimated token cost and elapsed arm time, including
  assessment calls and collection overhead.
- Missing outputs, failed invocations and unavailable usage as separate states.

Every attempted arm remains in the denominator. Missing output scores zero for
correctness and appropriate abstention. It has no actual unsafe proposal, but
`missing_output=1` and the failure override prevent an apparent safety gain from
qualifying as success. Partial or unknown usage makes total cost unavailable.
Timed-out invocations retain their host journals; the harness creates no fresh
retry identity. Restart preserves each arm's original deadline.

For a future principal evaluation, the provisional promotion thresholds require
at least a 5 percentage-point correctness gain, no more than a 1-point unsafe
proposal increase and no more than a 5-point abstention loss against **both**
comparators, with cost and latency no more than 1.1 times resampling. These are
explicit design assumptions requiring practical validation. A pilot or fixture
always reports `promotion=false`, even if its point estimates meet them.

The current pilot is numerically inadequate to resolve those margins. Repeat and
variant averages are first formed within family; six families supply the analysis
units. For bounded paired differences in [-1,1], Hoeffding's inequality and a
union bound over six contrasts give the simultaneous radius

`r = sqrt(2 * log(12 / 0.05) / n)`.

| Independent families | Conservative radius before clipping |
| --- | ---: |
| 6 | 1.351621 |
| 12 | 0.955740 |

These intervals are deliberately broad. The independence assumption itself is
conditional for purposively authored families; the intervals do not establish
production confidence. Repeats cannot repair a small independent-case count.
The next study must use independently adjudicated, fresh incident families and
an allocation justified using pilot discordance, missingness and cost estimates.
Do not choose its sample size from a favourable pilot treatment effect.

The source of the bound is Hoeffding (1963), [Probability Inequalities for Sums
of Bounded Random Variables](https://doi.org/10.1080/01621459.1963.10500830).
Its design consequence is to retain the actual bounded dependence unit. Lakens
(2022), [Sample Size Justification](https://doi.org/10.1525/collabra.33267), supports
making resource-constrained pilot limits explicit instead of implying adequate
precision. Both were checked when this protocol was created.

Retained bundles contain absolute local paths. Moving the archive to another
machine requires a new freeze; the archive preserves evidence for inspection,
not an automatically relocatable executable.

The output directory contains `lock.json`, retained bundle, immutable per-call
inputs/results/observations, host journals, arm records and `results.json`.
Formal models establish controller properties within their declared bounds;
only independent outcome observations can establish empirical improvement.

## Executed verification

The local credential-free rehearsal completed all 108 arm runs and 324 provider
effects with no failed or missing output. All three arms used the same scripted
abstaining provider, so their independent quality contrasts were zero. This
establishes collection and controller execution, not model efficacy. The 13
unit tests pass; the schema-1.2 investigation record validates without errors or
warnings. Retained invocation inputs confirm that the revision draft and the
corresponding one-pass generation received identical JSON context.

Rehearsal freeze: `7136b51c2e57138d0ea553bbfb88a1d0a57adf02227e439b6b65cff9e8ee640c`.
Host executable SHA256: `2d9cb2a2716e3fdc30bd2562eca8e533055b59a4ca5cad67b0067c3cb8311479`.
The CI fixture job repeats this procedure against the repository-pinned host.

The [persistent receipt](evidence/receipt.json) records the verified counts and
exact source/executable hashes. The [compressed fixture evidence](evidence/fixture-rehearsal.tar.xz)
contains the freeze, reports, arm records and all per-call JSON, with an internal
SHA256 manifest. It omits reproducible binaries and SQLite journals. Replay
produced the identical report with zero additional provider effects.
