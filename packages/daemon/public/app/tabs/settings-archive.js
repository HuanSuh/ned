/* 설정 → 아카이브 (config.archive, src/archive.ts): Obsidian 볼트에 데일리 리포트 + 정리 결과물 노트.
 * Fields save with the form (readArchive → PUT /api/config { archive }); the status line reads GET /api/archive/status
 * (볼트 배지 · 마지막 쓰기 · 마지막 오류) and "지금 쓰기" posts /api/archive/flush. */
import { api } from "../api.js";
import { $, esc } from "../util.js";

export const ARCH_INC = [["briefings", "🌅 아침 브리핑"], ["updates", "🔔 순찰 알림"], ["actions", "✉️ 보낸 것"], ["outputs", "📎 정리 결과물"], ["sessions", "🤖 세션"]];
const EMBED_KO = { inserted: "embed 넣음", present: "embed 있음", no_note: "그날 데일리 노트 없음(만들지 않음)", no_config: ".obsidian/daily-notes.json 없음", no_heading: "\"## 📝 Notes & Logs\" 제목 없음", bad_format: "데일리 노트 형식을 못 읽음" };
export const AS = { status: null, error: "", busy: false };

export function renderArchive(c) {
  const a = c?.archive || {};
  $("c-arch-on").checked = a.enabled === true;
  $("c-arch-vault").value = a.vault || "";
  $("c-arch-folder").value = a.folder || "Ned";
  $("c-arch-embed").checked = a.daily_embed === true;
  const inc = a.include || {};
  $("c-arch-inc").innerHTML = ARCH_INC.map(([k, label]) => `<label><input type="checkbox" data-arch-inc="${k}" ${(inc[k] ?? k !== "sessions") ? "checked" : ""}>${esc(label)}</label>`).join("");
  syncArchiveEnabled();
  loadArchiveStatus();
}

export function readArchive() {
  return {
    enabled: $("c-arch-on").checked,
    vault: $("c-arch-vault").value.trim(),
    folder: $("c-arch-folder").value.trim() || "Ned",
    daily_embed: $("c-arch-embed").checked,
    include: Object.fromEntries([...document.querySelectorAll("[data-arch-inc]")].map((x) => [x.dataset.archInc, x.checked])),
  };
}

/** Off → the rest dims (values kept and still saved). */
export function syncArchiveEnabled() {
  $("c-arch").classList.toggle("off", !$("c-arch-on").checked);
}

const when = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`; };

export async function loadArchiveStatus() {
  try { AS.status = await api("/api/archive/status"); AS.error = ""; } catch (e) { AS.error = e.status === 404 ? "이 데몬은 아카이브를 몰라 (업데이트 필요)" : e.message; }
  renderArchiveStatus();
}

export function renderArchiveStatus() {
  const box = $("c-arch-status"), badge = $("c-arch-badge");
  if (!box) return;
  const s = AS.status;
  if (AS.error || !s) { box.innerHTML = `<span class="hint">${esc(AS.error || "불러오는 중…")}</span>`; badge.hidden = true; return; }
  const chk = s.check;
  badge.hidden = !chk;
  if (chk) { badge.className = `chipx ${chk.ok ? (chk.obsidian ? "ok" : "") : "today"}`; badge.textContent = chk.ok ? (chk.obsidian ? "볼트 확인됨" : ".obsidian 없음 — 그래도 씀") : "쓸 수 없음"; badge.title = chk.error || chk.path; }
  const parts = [];
  if (!s.enabled) parts.push(`<span class="hint">꺼져 있어 — 켜고 볼트 경로를 넣은 뒤 저장.</span>`);
  if (chk && !chk.ok) parts.push(`<span class="err">⚠ ${esc(chk.error)}</span>`);
  parts.push(`<span class="hint">오늘 리포트: <code>${esc(s.today_rel)}</code>${s.today_url ? ` · <a href="${esc(s.today_url)}">Obsidian 에서 열기</a>` : ""}</span>`);
  parts.push(`<span class="hint">마지막 쓰기: ${s.last_write_at ? esc(when(s.last_write_at)) : "아직 없음"}${s.pending_days?.length ? ` · 대기 ${esc(s.pending_days.join(", "))}` : ""}${s.last_embed ? ` · 데일리 노트 ${esc(s.last_embed.day)}: ${esc(EMBED_KO[s.last_embed.result] || s.last_embed.result)}` : ""}</span>`);
  if (s.last_error) parts.push(`<span class="err" title="${esc(s.last_error)}">⚠ 마지막 오류 (${esc(when(s.last_error_at))}): ${esc(s.last_error)}</span>`);
  parts.push(`<span class="inl"><button type="button" class="btn small" id="c-arch-flush" ${s.enabled && chk?.ok && !AS.busy ? "" : "disabled"}>${AS.busy ? "쓰는 중…" : "지금 쓰기"}</button><button type="button" class="btn small" id="c-arch-reload">상태 새로고침</button></span>`);
  box.innerHTML = parts.join("");
}

async function flushNow() {
  AS.busy = true; renderArchiveStatus();
  try {
    const r = await api("/api/archive/flush", { method: "POST" });
    AS.status = r.status || AS.status;
  } catch (e) {
    if (e.data?.status) AS.status = e.data.status; else AS.error = e.message;
  } finally { AS.busy = false; renderArchiveStatus(); }
}

export const ARCH_CSS = `.arch .archst { display: flex; flex-direction: column; gap: 4px; font-size: 12px; } .arch .archst .err { color: var(--red); overflow-wrap: anywhere; }
.arch .archst code { font-size: 11px; } .arch.off > :not(:first-child) { opacity: .45; }`;

export function initArchive() {
  const st = document.createElement("style"); st.textContent = ARCH_CSS; document.head.appendChild(st);
  $("c-arch-on").addEventListener("change", syncArchiveEnabled);
  $("c-arch-status").addEventListener("click", (e) => {
    const id = e.target.closest("button")?.id;
    if (id === "c-arch-flush") { e.preventDefault(); flushNow(); }
    else if (id === "c-arch-reload") { e.preventDefault(); loadArchiveStatus(); }
  });
}
