// @vitest-environment jsdom
/**
 * 할 일 카드 분할 (public/app/features/todosplit.js): 위 = 확인 필요 그룹, 아래 = 개인 할 일.
 * - pure: split 복원(readSplit), 최소 높이(meMinPx), 위 영역 최대 높이(upMaxPx), 드래그 → 비율(splitFromY);
 * - DOM: 접힘 상태(localStorage ned.todo.meFold) 복원·토글, free grid 에서만 구분선 + --me-min / --up-max.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import * as TS from "../public/app/features/todosplit.js";

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const indexHtml = fs.readFileSync(path.join(pub, "index.html"), "utf8");
const cardHtml = indexHtml.slice(indexHtml.indexOf('<section class="card" id="todo-card">'), indexHtml.indexOf('<div class="sgrid" id="sgrid">'));

describe("pure", () => {
  it("readSplit: absent / junk → null, numbers clamped to [10, 90]", () => {
    expect(TS.readSplit(null)).toBeNull();
    expect(TS.readSplit("")).toBeNull();
    expect(TS.readSplit("abc")).toBeNull();
    expect(TS.readSplit("42.37")).toBe(42.4);
    expect(TS.readSplit("3")).toBe(10);
    expect(TS.readSplit("99")).toBe(90);
  });
  it("readFold: only '1' folds", () => {
    expect(TS.readFold("1")).toBe(true);
    for (const v of [null, "0", "", "true"]) expect(TS.readFold(v)).toBe(false);
  });
  it("meMinPx: header + form + 3 rows (180px), or the content when shorter", () => {
    expect(TS.ME_FLOOR).toBe(180);
    expect(TS.meMinPx(600)).toBe(180);
    expect(TS.meMinPx(120.4)).toBe(120);
    expect(TS.meMinPx(undefined)).toBe(0);
  });
  it("upMaxPx: default 60%, a short personal list gives its room back; stored split as is; personal min kept", () => {
    expect(TS.upMaxPx({ H: 1000, meNat: 800, split: null })).toBe(600); // both long → 60 / 40
    expect(TS.upMaxPx({ H: 1000, meNat: 150, split: null })).toBe(850); // personal content 150 → upper gets the rest
    expect(TS.upMaxPx({ H: 1000, meNat: 800, split: 30 })).toBe(300);
    expect(TS.upMaxPx({ H: 1000, meNat: 800, split: 90 })).toBe(820); // never below the personal minimum (180)
    expect(TS.upMaxPx({ H: 300, meNat: 800, split: null })).toBe(120); // small card: personal keeps 180
    expect(TS.upMaxPx({ H: 100, meNat: 800, split: null })).toBe(0);
  });
  it("splitFromY: drag position → stored %, clear of both minimums", () => {
    expect(TS.splitFromY({ y: 500, H: 1000, meNat: 800 })).toBe(50);
    expect(TS.splitFromY({ y: 990, H: 1000, meNat: 800 })).toBe(82); // personal min 180
    expect(TS.splitFromY({ y: 5, H: 1000, meNat: 800 })).toBe(10); // upper floor 64px → 6.4% → clamped to 10
  });
});

describe("DOM", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = `<div id="hgrid" class="free">${cardHtml}</div>`;
  });

  it("markup: upper area, hidden divider (separator), foldable 개인 할 일 header with its count badge", () => {
    expect(document.querySelector("#todo-bd > #todo-up > .tgrp.g-ned")).toBeTruthy();
    const hd = document.getElementById("todo-split")!;
    expect(hd.getAttribute("role")).toBe("separator");
    expect(hd.hidden).toBe(true);
    const tog = document.querySelector("#grp-me > button#me-fold")!;
    expect(tog.getAttribute("aria-controls")).toBe("me-gl");
    expect(tog.querySelector("#n-me")).toBeTruthy();
    expect(document.querySelector("#me-gl > #tadd")).toBeTruthy();
  });

  it("free grid: divider on, --me-min / --up-max set (min = min(180, content))", () => {
    TS.layoutTodoSplit();
    const bd = document.getElementById("todo-bd")!;
    expect(bd.classList.contains("tsplit")).toBe(true);
    expect(document.getElementById("todo-split")!.hidden).toBe(false);
    // jsdom has no layout: every height is 0 → content 0 + margins
    expect(bd.style.getPropertyValue("--me-min")).toMatch(/^\d+px$/);
    expect(bd.style.getPropertyValue("--up-max")).toMatch(/^\d+px$/);
    expect(document.getElementById("todo-split")!.getAttribute("aria-valuenow")).toBe("60");
    localStorage.setItem(TS.SPLIT_KEY, "35");
    TS.layoutTodoSplit();
    expect(document.getElementById("todo-split")!.getAttribute("aria-valuenow")).toBe("35");
  });

  it("stacked flow (no .free): no divider, no size variables", () => {
    document.getElementById("hgrid")!.classList.remove("free");
    TS.layoutTodoSplit();
    const bd = document.getElementById("todo-bd")!;
    expect(bd.classList.contains("tsplit")).toBe(false);
    expect(document.getElementById("todo-split")!.hidden).toBe(true);
    expect(bd.style.getPropertyValue("--up-max")).toBe("");
  });

  it("fold: restored from localStorage, header click toggles + stores, folded → upper takes it all (no divider)", () => {
    localStorage.setItem(TS.FOLD_KEY, "1");
    TS.init();
    const me = document.getElementById("grp-me")!, tog = document.getElementById("me-fold")!;
    expect(me.classList.contains("fold")).toBe(true);
    expect(document.getElementById("me-gl")!.hidden).toBe(true);
    expect(tog.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("todo-split")!.hidden).toBe(true);
    tog.click();
    expect(localStorage.getItem(TS.FOLD_KEY)).toBe("0");
    expect(me.classList.contains("fold")).toBe(false);
    expect(document.getElementById("me-gl")!.hidden).toBe(false);
    expect(document.getElementById("todo-split")!.hidden).toBe(false);
  });

  it("개인 할 일 filtered out → no divider; double-click resets the stored split", () => {
    TS.init();
    localStorage.setItem(TS.SPLIT_KEY, "30");
    document.getElementById("todo-split")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(localStorage.getItem(TS.SPLIT_KEY)).toBeNull();
    document.getElementById("grp-me")!.hidden = true;
    TS.layoutTodoSplit();
    expect(document.getElementById("todo-split")!.hidden).toBe(true);
  });
});
