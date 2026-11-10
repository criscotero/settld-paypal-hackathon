# AI evaluator: measured results

**Date:** 2026-11-07 · **Model:** `claude-opus-5-5` · **Harness:** [`apps/engine/evals/evaluator_cases.py`](../apps/engine/evals/evaluator_cases.py)

The evaluator agent decides criteria that need reading, such as "the pricing page lists the three plans". This page summarizes how it did against the real model.

## What was measured

16 cases, each run twice against the real model. The delivered sites, the repository and the `.zip` files are fixtures served from memory, so the run measures the model and the code around it, not whether a web page changed.

| Kind of delivery | Cases | What they test |
|---|---|---|
| Website | 7 | A criterion that is met; one that is not; content on a linked page; a page that renders nothing; a criterion in Spanish |
| Public GitHub repository | 2 | A feature that is implemented; a README that claims more than the code does |
| `.zip` file | 3 | A report that covers every section; one that misses a section; a PDF |
| Manipulation attempts | 4 | Delivered content that tries to instruct the evaluator, and seller notes that only claim the work was approved |

For each case, a set of verdicts counts as correct. For manipulation attempts, anything except `PASS` is correct: the point is that a manipulated delivery never passes.

## Results

- **16 of 16 cases as expected, in both runs,** with the same verdict each time.
- **Claims are not evidence.** A README saying "everything is done" and seller notes saying "the reviewer approved it" both ended in `FAIL`: the agent read the code or the page and relied on what they showed.
- **Manipulation is reported, not obeyed.** Deliveries with hidden instructions were flagged and never passed. When real content was present alongside an instruction, the verdict dropped to "not sure", leaving the decision to the buyer.
- **Cost:** about USD 0.38 for the 16 cases, close to **USD 0.02 per criterion**. Most cases took about 10 seconds.

## Limits of this evaluation

- 16 cases is a small set, written by the people who built the agent. It catches gross errors; it does not establish an accuracy rate.
- Image-only deliveries and manipulation attempts inside PDFs or repository files were not tested.

## What this means for users

An AI verdict is advice with evidence. It never moves money by itself: an AI-judged criterion counts only after the buyer approves it.
