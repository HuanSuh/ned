/* Persona picker is a hidden feature: the settings tab doesn't render it until it's unlocked for this page session —
 * tap the "설정" title 5 times in a row, or run `persona` in the ⌘K palette (search.js fires "ned:persona-unlock").
 * Nothing is stored (no localStorage): a reload hides it again. config.persona and its theme/voice/mark still apply
 * either way, so a value written straight into config.yaml keeps working. No DOM access at import (unit-tested). */
export const UNLOCK_TAPS = 5;
export const TAP_GAP_MS = 1500; // a pause longer than this starts the count over

let unlocked = false, taps = 0, lastTap = 0;

export const personaUnlocked = () => unlocked;
/** Unlock for this session. Returns true only on the call that actually unlocked it. */
export function unlockPersona() { const was = unlocked; unlocked = true; taps = 0; return !was; }
/** Test hook: back to the locked default. */
export function resetPersonaGate() { unlocked = false; taps = 0; lastTap = 0; }
/** One tap on the settings title. Returns true when this tap unlocked the picker. */
export function tapTitle(now = Date.now()) {
  if (unlocked) return false;
  taps = lastTap && now - lastTap <= TAP_GAP_MS ? taps + 1 : 1;
  lastTap = now;
  return taps >= UNLOCK_TAPS ? unlockPersona() : false;
}

/** Inner markup of #f-persona: empty while locked; the radiogroup is filled by renderPersonaPicker. */
export function personaFieldHtml(on = unlocked) {
  if (!on) return "";
  return `<span class="lab" id="pp-lab">페르소나 (말투 · 테마 · 마크)</span>`
    + `<div class="ppick" id="c-persona" role="radiogroup" aria-labelledby="pp-lab"></div>`
    + `<span class="hint">기능과 데이터는 그대로고 말투·색·마크만 바뀌어. 저장하면 바로 적용돼.</span>`;
}
