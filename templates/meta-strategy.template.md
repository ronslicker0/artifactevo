# Mutation Strategy

## Priority Order
1. If scorecard shows missing behavior (evaluator failed, no relevant rule) → ADD_RULE
2. If rule exists but evaluator shows wrong application → ADD_EXAMPLE
3. If same error pattern repeats 3+ times in archive → ADD_NEGATIVE_EXAMPLE
4. If important rule is buried below line 50 → REORDER
5. If artifact > 200 lines with low score improvement → SIMPLIFY
6. If multiple scattered rules cover same topic → MERGE_RULES
7. If sections are disorganized (related content far apart) → RESTRUCTURE
8. If wording is ambiguous (evaluator scores fluctuate) → REPHRASE
9. If a rule consistently causes regressions → DELETE_RULE

## Diversity Rules
- Never apply the same mutation type twice consecutively on the same artifact
- If a mutation type has <20% success rate over the last 10 runs, deprioritize it
- After 3 consecutive ADD_* mutations, try a structural mutation (REORDER/SIMPLIFY/RESTRUCTURE)

## Artifact Type Adaptations
- **prompt**: Focus on behavioral rules, examples, and instruction clarity
- **config**: Focus on value optimization, remove unused keys, simplify nesting
- **template**: Focus on variable coverage, output format clarity, edge cases
- **doc**: Focus on completeness, accuracy, actionability of instructions

## Current Biases
(The outer loop will write adjustments here based on global statistics)
