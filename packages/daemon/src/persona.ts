import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PersonaId } from "./config.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PERSONAS_DIR = path.resolve(here, "../../../prompts/personas");

/** The {{PERSONA}} block: prompts/personas/<id>.md (name, tone rules, headline / NED_OK examples, don'ts). Falls back to ned. */
export function personaPrompt(id: PersonaId): string {
  for (const p of [id, "ned"]) {
    try {
      return fs.readFileSync(path.join(PERSONAS_DIR, `${p}.md`), "utf8").trim();
    } catch {
      /* try the next one */
    }
  }
  return "### Ned\n- 친한 동료 반말로, 짧고 구체적으로.";
}
