// Regression fixture (John, Oct 23): the Oct 22 demo set's Q2 as generated before the quality rules.
// arr = [2, 7, 4, 9, 6] with target 13 has TWO valid pairs ({1,4}: 7 + 6 and {2,3}: 4 + 9), so the
// keyed answer only held for one implementation's iteration order; it cites "the professor's
// solution" without showing it; and every option carries a "because…" explanation.
// Every check must reject it: lib/questions/rules.ts in code, and lib/pipeline/generate.ts even
// when a (fake) model check says it's fine.

export const BAD_OCT22_Q2 = {
  stem: "Using the professor's unordered_map solution to two_sum, what pair is returned for arr = [2, 7, 4, 9, 6] and target = 13?",
  choices: {
    A: "{1, 4}, because 7 + 6 = 13",
    B: "{2, 3}, because 4 + 9 = 13",
    C: "{3, 2}, because 9 is reached after 4 is stored",
    D: "{-1, -1}, because the map is checked before anything is stored",
  },
  answer: "B" as const,
  explanation: "At i = 3, diff = 13 - 9 = 4 is already in the map with index 2, so result becomes {2, 3} and the loop breaks before 7 + 6 is ever considered.",
};
