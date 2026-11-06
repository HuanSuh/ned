import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { TAP_GAP_MS, UNLOCK_TAPS, personaFieldHtml, personaUnlocked, resetPersonaGate, tapTitle, unlockPersona } from "../public/app/features/persona-gate.js";

beforeEach(() => resetPersonaGate());

describe("persona picker is a hidden feature", () => {
  it("renders nothing by default", () => {
    expect(personaUnlocked()).toBe(false);
    expect(personaFieldHtml()).toMatchInlineSnapshot(`""`);
  });

  it("5 quick taps on the settings title unlock it, then it renders", () => {
    let t = 1_000;
    for (let i = 1; i < UNLOCK_TAPS; i++) expect(tapTitle((t += 200))).toBe(false);
    expect(personaUnlocked()).toBe(false);
    expect(tapTitle((t += 200))).toBe(true);
    expect(personaUnlocked()).toBe(true);
    expect(tapTitle((t += 200))).toBe(false); // already open: no second unlock
    expect(personaFieldHtml()).toMatchInlineSnapshot(`"<span class="lab" id="pp-lab">페르소나 (말투 · 테마 · 마크)</span><div class="ppick" id="c-persona" role="radiogroup" aria-labelledby="pp-lab"></div><span class="hint">기능과 데이터는 그대로고 말투·색·마크만 바뀌어. 저장하면 바로 적용돼.</span>"`);
  });

  it("a pause between taps starts the count over", () => {
    let t = 1_000;
    for (let i = 0; i < UNLOCK_TAPS - 1; i++) tapTitle((t += 100));
    expect(tapTitle((t += TAP_GAP_MS + 1))).toBe(false); // counts as tap #1 again
    for (let i = 0; i < UNLOCK_TAPS - 2; i++) expect(tapTitle((t += 100))).toBe(false);
    expect(tapTitle((t += 100))).toBe(true);
  });

  it("the ⌘K `persona` command unlocks once; nothing is persisted", () => {
    expect(unlockPersona()).toBe(true);
    expect(unlockPersona()).toBe(false);
    expect(personaFieldHtml()).not.toBe("");
    resetPersonaGate(); // ≈ reload: back to hidden
    expect(personaFieldHtml()).toBe("");
  });
});
