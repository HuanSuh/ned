/* Draft / action refs + the ✎ (draft) and ⋯ (item actions) buttons — pure (no DOM at import), so node tests can check
 * what each list puts in data-draft / data-axm. drafts.js and actions.js re-export everything here. */
import { S } from "../state.js";
import { iconBtn } from "../ui/icons.js";
import { esc } from "../util.js";

export const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ""));
/** Where a draft / action was started (src/origin.ts): card row, "지난 N일" 이력 row, 팔로업 card, Ned Net 대화창. */
export const ORIGINS = ["card", "history", "watch", "chat"];
export const ORIGIN_KO = { chat: "대화창", card: "카드", history: "지난 N일", watch: "팔로업" };
const ORIGIN_TITLE = { chat: "Ned Net 대화창의 확인 카드에서 실행", card: "홈 카드 행의 ✎ / ⋯ 에서 실행", history: "카드의 '지난 N일' 이력 행에서 실행", watch: "팔로업 채널 카드(행 · 최근 대화 · 요약 줄)에서 실행" };
/** 출처 chip for an action log entry (설정 → 오늘 한 액션); "" for older entries without origin. */
export const originChip = (o) => (ORIGINS.includes(o) ? ` <span class="chipx org-${esc(o)}" title="${esc(ORIGIN_TITLE[o])}">${esc(ORIGIN_KO[o])}</span>` : "");
const SLACK_P_RE = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/;

/**
 * ref for a Slack message: channel id + ts (+ thread_ts) from its permalink. A followed thread (agenda slack.threads)
 * → reply into it, and let /api/draft use its latest excerpt. `opts.thread`: the message's own ts becomes thread_ts
 * when the permalink names none (팔로업: always a thread reply, never a new channel message; DMs excepted).
 */
export function slackRef(x, opts = {}) {
  const m = SLACK_P_RE.exec(x.url || ""), tt = /[?&]thread_ts=([\d.]+)/.exec(x.url || "");
  const ts = m ? `${m[2]}.${m[3]}` : undefined, channel = m?.[1] || x.channel;
  const key = m ? `${m[1]}:${tt?.[1] || ts}` : "";
  const th = x.thread || (key && (S.agenda?.slack?.threads || []).find((t) => t.key === key));
  let thread_ts = tt?.[1] || (th && th.reply_count > 0 ? th.thread_ts : undefined);
  if (!thread_ts && opts.thread && ts && !String(m?.[1] || "").startsWith("D")) thread_ts = ts;
  return clean({ url: x.url, channel, ts, thread_ts, title: [x.channel, x.from].filter(Boolean).join(" · ") || x.title, text: x.text || x.detail });
}
export const mailRef = (x) => clean({ url: x.url, thread_id: x.id || /#[\w-]+\/([^|?&#\s]+)/.exec(x.url || "")?.[1], title: [x.subject || x.title, x.from].filter(Boolean).join(" — "), text: x.why || x.snippet || x.detail });
export const sessionRef = (x) => clean({ session_id: x.id, title: x.worktree, text: x.last_summary || (x.last_prompt ? "» " + x.last_prompt : "") });

export const jiraRef = (x) => clean({ url: x.url, key: x.key || /\/browse\/([A-Z][A-Z0-9_]*-\d+)/i.exec(x.url || "")?.[1], title: [x.key, x.title].filter(Boolean).join(" ") || x.title, text: x.status ? `상태: ${x.status}` : x.detail });
export function githubRef(x) {
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(x.url || "");
  return clean({ url: x.url, repo: x.repo || m?.[1], number: x.number != null ? String(x.number) : m?.[2], title: x.title, text: x.detail });
}
/** Google Calendar `eid` = base64("<eventId> <calendarId>") → both ids. */
export function decodeEid(url) {
  const eid = /[?&]eid=([^&#]+)/.exec(url || "")?.[1];
  if (!eid) return {};
  try {
    const b64 = decodeURIComponent(eid).replace(/-/g, "+").replace(/_/g, "/");
    const [event_id, calendar_id] = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)).split(" ");
    return { event_id, calendar_id: calendar_id && calendar_id !== "primary" ? calendar_id.replace(/@m$/, "") : undefined };
  } catch { return {}; }
}
export const calRef = (e) => { const d = decodeEid(e.url); return clean({ url: e.url, event_id: e.id || d.event_id, calendar_id: d.calendar_id, title: e.title, rsvp: e.rsvp }); };
export const REF_OF = { jira: jiraRef, github: githubRef, calendar: calRef };

/** The ⋯ button for one item. `kind` = jira | github | calendar; `origin` rides along to /api/draft · /api/send. */
export function axBtn(kind, item, origin = "") {
  const ref = REF_OF[kind]?.(item);
  if (!ref || (kind === "calendar" && (!ref.event_id || item.rsvp === "organizer"))) return "";
  return `<button type="button" class="ib axb" data-axm="${esc(JSON.stringify(clean({ kind, ref, origin })))}" title="액션 — ${kind === "jira" ? "코멘트·상태 변경" : kind === "github" ? "리뷰·승인" : "참석 응답"}" aria-label="액션 메뉴" aria-haspopup="menu" aria-expanded="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h.01M12 12h.01M18 12h.01" stroke-width="3"/></svg></button>`;
}

/**
 * Button that opens the draft modal. `opts`: origin (card | history | watch), soft (dimmed until hover — rows that don't
 * need me), note (one line at the top of the modal, e.g. "가장 최근 메시지 기준"), pick (several candidates → the
 * modal asks which one first: [{source, ref, label}]).
 */
export function draftBtn(source, ref, att = "", opts = {}) {
  const o = typeof opts === "string" ? { origin: opts } : opts || {};
  const data = clean({ source, ref, origin: o.origin, note: o.note, pick: o.pick?.length ? o.pick : undefined });
  const label = o.pick?.length ? `답장 초안 — 어느 메시지에 답할지 먼저 골라 (${o.pick.length}개 후보)` : o.title || "답장 초안 — Ned 가 3가지 말투로 써 줘";
  return iconBtn("draft", label, { cls: `drb${o.soft ? " soft" : ""}`, attrs: `data-draft="${esc(JSON.stringify(data))}"${att ? ` data-att="${esc(att)}"` : ""}` });
}
/** ✎ for Slack / mail, ⋯ for Jira / GitHub / calendar, "" otherwise. `opts` as draftBtn (+ thread for slackRef). */
export function draftFor(kind, item, att = "", opts = {}) {
  const o = typeof opts === "string" ? { origin: opts } : opts || {};
  if (kind === "slack") return draftBtn("slack", slackRef(item, o), att, o);
  if (kind === "email") return draftBtn("email", mailRef(item), att, o);
  if (kind === "jira" || kind === "github" || kind === "calendar") return axBtn(kind, item, o.origin);
  return "";
}
/** A data-draft / data-axm attribute → the object (tests, click handlers). */
export const parseDraftAttr = (s) => { try { return JSON.parse(s); } catch { return null; } };
