import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PersonaId } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = path.resolve(here, "../../../prompts/personas");

/**
 * Rule shared by every persona: how Ned refers to *other people*. Ned's text shows up on screen (desktop pet bubble,
 * notifications, dashboard) where the person named — or anyone beside the user, or a screen share — can read it, so a
 * casual persona voice must not spill over onto third parties ("○○가 링크 줬어" reads as talking down about them).
 */
export const THIRD_PERSON_RULE = [
  "다른 사람 부르기 (모든 페르소나 공통)",
  "- 사용자 말고 다른 사람(동료·외부인)을 가리킬 때는 이름 뒤에 \"님\"을 붙인다: \"지수님이 링크 줬어\", \"지수님 답 기다리는 중\". 이름만 쓰거나(\"지수가\") 낮춰 부르지 않는다.",
  "- 말투(반말·존댓말·관제 어조)는 위 페르소나를 따르되, 사람 이름에만 이 규칙을 적용한다. 화면에 뜬 문장을 그 사람이나 옆 사람이 볼 수 있다.",
  "- 사람에 대한 평가·감정 표현(\"또\", \"늦게\", \"귀찮게\" 등)은 쓰지 않는다. 사실만.",
].join("\n");

/** The {{PERSONA}} block: prompts/personas/<id>.md (name, tone rules, headline / NED_OK examples, don'ts) + THIRD_PERSON_RULE. Falls back to ned. */
export function personaPrompt(id: PersonaId): string {
  for (const p of [id, "ned"]) {
    try {
      return `${fs.readFileSync(path.join(PERSONAS_DIR, `${p}.md`), "utf8").trim()}\n\n${THIRD_PERSON_RULE}`;
    } catch {
      /* try the next one */
    }
  }
  return `### Ned\n- 친한 동료 반말로, 짧고 구체적으로.\n\n${THIRD_PERSON_RULE}`;
}
