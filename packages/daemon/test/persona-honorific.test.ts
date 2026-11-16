import { describe, expect, it } from "vitest";
import { personaPrompt, THIRD_PERSON_RULE } from "../src/persona.js";

// Ned's lines land on screen (desktop pet bubble) where the named colleague can read them —
// every persona must carry the "other people get 님" rule, not just the polite ones.
describe("persona: third-person honorific rule", () => {
  it.each(["ned", "alfred", "jarvis", "oracle"] as const)("%s prompt includes the shared rule", (id) => {
    const p = personaPrompt(id);
    expect(p).toContain(THIRD_PERSON_RULE);
    expect(p).toContain("님");
  });

  it("unknown persona falls back to ned, still with the rule", () => {
    const p = personaPrompt("batman" as never);
    expect(p).toContain("### Ned");
    expect(p).toContain(THIRD_PERSON_RULE);
  });
});
