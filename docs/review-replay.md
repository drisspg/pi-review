# Paired review replay

This is a local experiment, not an automatic rollout gate. It compares the two **local review surfaces together** (maintainer judgment and focus areas), not four prompts against two prompts as four separate votes.

## What ran

The baseline is `ab8c0ef`: separate `main-review` and `focus-review` runs. The comparison freezes the proposed `createAnalysisApi` and `createReviewPromptApi` and starts one main review; the app runs two initial investigations, verification and synthesis. Both arms call real `registerPiSessionContext`/`askPi` through RPC. No archived AI answers, drafts, preference memory, or human feedback enter either arm. No synthetic fixture is included in the live-PR cohort.

The local manifest pins 24 distinct saved PR heads and their merge bases. Eligibility required local Git objects, 1–30 text files, file-count agreement, and at most 150,000 characters of patch input. The pilot is attention-gym #930 (`63b07ba9a852`). Remaining heads were selected in round-robin order across same-head request-changes, approval, comment and no-record strata. Including the pilot, the strata contain 3 requests for changes, 7 approvals, 7 comments and 7 without a same-head verdict. These are sampling strata, **not** bug or clean labels. This is not a random sample of all PRs.

Agents can inspect numbered source lines, enumerate files and search literal text in either immutable Git tree. This replaces production shell/filesystem tools with bounded read-only equivalents: source investigation is real, but neither PR code nor tests can execute; there is no GitHub or web lookup. Production checkouts are only Git object sources. Working directories, state and sessions are private and separate per arm; no application server or publishing API runs. Timing includes local model/tool/session overhead.

**Budget.** Both arms use `plugboard-codex/gpt-6.2-astra`, medium effort, two reviewer sessions maximum, six minutes per arm, and the same requested output allowance (4,096 tokens per response, declining with a 12,000-token allowance per session). No duplicate baseline calls are added to spend unused tokens. Compare actual output and total input/output/cache accounting separately: cache reads are repeatedly presented context, not newly generated tokens or a dollar price. A common ceiling does **not** imply equal compute. The batch checks a 24-million-total-token stopping threshold between arms; a last arm can cross it. It also stops before starting another six-minute arm too near the 90-minute deadline, on incomplete artifacts, or after two consecutive invalid arms. Arms are serial; initial reviewers within an arm may overlap.

## Pilot: attention-gym #930

| Arm | Wall time | Total tokens | Cache-read tokens | Output tokens | Source tool calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Independent, `ab8c0ef` | 54.1 s | 747,030 | 636,991 | 4,768 | 97 |
| Coordinated, exploratory (full patch repeated on handoffs) | 109.2 s | 1,471,472 | 1,276,126 | 8,927 | 143 |
| Coordinated, frozen final (file list on handoffs) | 110.2 s | 1,468,862 | 1,316,901 | 9,202 | 155 |

All three completed. “Frozen final” here means experimental patch `584c5768`, before the human-readable finding and Evidence-disclosure contract. This replay measured coordination, not the newer presentation. The final used **1.93× the generated output and 2.04× the wall time** of independent review. Request receipts matched the persisted assistant messages; all tool results were from the snapshot tool, with zero tool errors. The two coordinated runs used the same PR and reused the same legacy baseline; they are not independent cases or a controlled benchmark of the file-list optimization.

Both arms recommended landing. Legacy flagged retention of retired compiled callables after clearing and relaunching on a reused kernel. Final coordinated kept that issue and flagged the changed dtype requirement for custom `op=` overrides; it treated both as nonblocking. The exploratory coordinated run kept the override migration only. Static inspection supports the retention mechanism (kernel construction cache plus token rotation without deleting old memo entries) and the override migration (the base delayed-reader test omitted `gate_dtype`, the HEAD test supplies it). Neither runtime impact nor significance was measured. This pilot shows what the outputs did, **not** that coordination improved recall or reduced false blockers across PRs.

## Outcome at the budget stop

Thirteen of the 24 revisions finished both workflows (26 valid arms); none of the remaining 11 were run. The 24-million accounted-token threshold stopped the batch, not its time limit. Median wall time was 52 seconds independent vs. 110 seconds coordinated; maxima were 80 and 143 seconds. Both workflows found both predeclared issues. Static adjudication found useful differences in both directions: coordinated review gave an explicit wrong-gradient counterexample on PyTorch #196988, while independent review retained a scalar-mask alias regression on #196752 that coordination missed. Neither observation establishes an overall precision rate. The local report directory also contains the full case-by-case `outcome.md`.

## Local evidence

The durable, owner-only report directory on the experiment host is `~/Library/Application Support/pi-review-experiments/ab8c0ef-584c5768/`. `manifest.json` names the pinned heads, strata and source-patch fingerprint. `progress.json` records running/completed/failed arms, measured receipts, elapsed time and last update. `arm-results/` contains the actual judgments. `blind/` randomizes A/B independently per revision; the mapping is separate in `keys/`. `adjudication.md` names the preselected reference issues. `harness/` archives the machine-specific runner. The `private-run-root` pointer locates the short-lived raw sessions and executable frozen trees. These private artifacts are not checked in or sent anywhere for scoring.

To check real progress without making a model call:

```sh
jq '{status, current, reason, completed_arms: (.arms | length), valid_arms: ([.arms[] | select(.valid)] | length), observed_tokens: ([.arms[].tokens.totalTokens] | add)}' "$HOME/Library/Application Support/pi-review-experiments/ab8c0ef-584c5768/progress.json"
```

## Score the review, not the format

1. Inspect the paired A/B outputs without the key. Count one issue per distinct root cause and corrective action. A judgment mentioning an inline issue is not another detection. Check independent findings not mentioned in the saved human review against the actual base, supported callers and HEAD; they are not automatically false.
2. Record whether the intended change works, which material risks the judgment leaves unverified, and what it explicitly makes a condition of landing. Count a **false blocker** only for an unsupported, stale or pre-existing concern presented as a landing condition. Rare but valid input counts if the changed path really breaks for it. A useful nonblocking note is not a false blocker.
3. Two same-revision held-out references identify concrete testable contracts: state-layout preservation in attention-gym #913 and device-local RHS dtype conversion in pytorch #196752. For each, score detected / missed / explicitly inconclusive with supporting lines. These are scoped references, not exhaustive ground truth. An approved PR with only documentation feedback is a useful overblocking probe, not proof of cleanliness.
4. Compare independent judgments before unblinding, retaining disagreements and uncertainty. Tokens, latency, parser success and duplication can be observed without a quality label. No aggregate precision, recall, superiority or clean-PR rate follows from silence, merge status, a successful parse, or synthetic regression tests.
