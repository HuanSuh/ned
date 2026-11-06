import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Persona is an unshipped feature: no UI opens a picker. config.persona (config.yaml) still drives theme/voice/mark.
const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(pkg, "../..");
const read = (p: string) => fs.readFileSync(p, "utf8");

describe("persona has no UI entry point", () => {
  it("the dashboard has no picker markup, gate module or unlock hooks", () => {
    expect(fs.existsSync(path.join(pkg, "public/app/features/persona-gate.js"))).toBe(false);
    const html = read(path.join(pkg, "public/index.html"));
    expect(html).not.toMatch(/f-persona|c-persona|name="persona"/);
    const settings = read(path.join(pkg, "public/app/tabs/settings.js"));
    expect(settings).not.toMatch(/persona-gate|renderPersonaPicker|tapTitle|unlockPersona|persona-unlock|c-persona/);
    expect(settings).not.toMatch(/^\s*persona:/m); // the save body doesn't send persona (PUT keeps the current value)
    expect(read(path.join(pkg, "public/css/tokens.css"))).not.toMatch(/\.ppick|\.pcard/);
  });

  it("the ⌘K palette has no persona command", () => {
    const search = read(path.join(pkg, "public/search.js"));
    expect(search).not.toMatch(/id: "persona"|persona-unlock|unlock:/);
  });

  it("the menu-bar dropdown has no persona submenu or ⌥ detection", () => {
    const menu = read(path.join(repo, "apps/menubar/Sources/Ned/MenuContent.swift"));
    expect(menu).not.toMatch(/personaMenu|showPersona|setPersona|\.option\)|Picker\("페르소나"/);
  });
});
