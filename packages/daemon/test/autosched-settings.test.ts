// @vitest-environment jsdom
/**
 * 설정 → 순찰 주기 → 조용한 시간 동작 / 유휴 시 동작 (public/app/features/autosched.js):
 * render from config, read back into the PUT body shape, dimming follows 조용한 시간 '사용' and 유휴 '사용'.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const indexHtml = fs.readFileSync(path.join(pub, "index.html"), "utf8");
const { readAutoSched, renderAutoSched } = await import("../public/app/features/autosched.js");
const $ = (id: string) => document.getElementById(id) as HTMLInputElement;

beforeEach(() => {
  document.body.innerHTML = indexHtml.slice(indexHtml.indexOf("<body"), indexHtml.lastIndexOf("</body>")).replace(/^<body[^>]*>/, "");
});

describe("autosched settings block", () => {
  it("renders config and reads it back unchanged", () => {
    const c = { quiet_schedule: { mode: "pause", slow_factor: 4 }, idle_schedule: { enabled: false, after_minutes: 90, unchanged_runs: 3, mode: "pause", slow_factor: 8 } };
    $("c-qon").checked = true;
    renderAutoSched(c);
    expect(readAutoSched()).toEqual(c);
    expect(document.querySelector<HTMLInputElement>("input[name=qs-mode][value=pause]")!.checked).toBe(true);
  });

  it("older daemon (no keys) → defaults; edits clamp", () => {
    renderAutoSched({});
    expect(readAutoSched()).toEqual({ quiet_schedule: { mode: "slow", slow_factor: 6 }, idle_schedule: { enabled: true, after_minutes: 120, unchanged_runs: 6, mode: "slow", slow_factor: 6 } });
    $("qs-factor").value = "99";
    $("is-after").value = "3";
    expect(readAutoSched().quiet_schedule.slow_factor).toBe(24);
    expect(readAutoSched().idle_schedule.after_minutes).toBe(10);
  });

  it("quiet hours off dims the quiet block; idle off disables its fields", () => {
    $("c-qon").checked = false;
    renderAutoSched({ idle_schedule: { enabled: false } });
    expect($("qs-blk").classList.contains("off")).toBe(true);
    expect($("is-blk").classList.contains("off")).toBe(true);
    expect($("is-after").disabled).toBe(true);
    $("c-qon").checked = true;
    $("c-qon").dispatchEvent(new Event("change", { bubbles: true }));
    expect($("qs-blk").classList.contains("off")).toBe(false);
    $("is-on").checked = true;
    $("is-on").dispatchEvent(new Event("change", { bubbles: true }));
    expect($("is-after").disabled).toBe(false);
  });
});
