/**
 * 메일 확인 완료 → Gmail 읽음 표시 (config.actions.gmail_mark_read, default off).
 *
 * POST /api/attention/mail:<thread>/review {reviewed:true} calls onMailReviewed right after reviewed.json is written:
 *  1. optimistic: agenda.json's mail.all[] row for that thread → unread=false, mail.unread −1 (only if it was unread;
 *     the next mail refresh overwrites both with Gmail's real values);
 *  2. a background send job (send-jobs.ts, mode "mark_read") removes the UNREAD label via claude -p with only
 *     unlabel_thread allowed — logged in sent-actions.log like every other write.
 * Skipped: option off, a bad thread id, the same thread marked read ok within 10 min (send-jobs dedupe), or today's
 * spend ≥ agenda_daily_budget_usd (hard stop, logged). Un-reviewing never marks the thread unread again.
 */
import { GMAIL_THREAD_ID, appendActionLog, type SendRequest } from "./actions.js";
import { patchAgenda, type Agenda } from "./agenda.js";
import type { NedConfig } from "./config.js";
import { todayCost } from "./costs.js";
import { log } from "./paths.js";
import { startSendJob } from "./send-jobs.js";

export interface MarkReadOutcome {
  /** A job was started (or joined): poll GET /api/send/:job_id. */
  job_id?: string;
  started_at?: string;
  /** Why no job ran: "already" (done in the last 10 min), "budget" (daily hard stop), "invalid" (thread id). */
  skipped?: "already" | "budget" | "invalid";
  detail?: string;
}

/** agenda.mail: that thread read now (unread=false, count −1 once). True when something changed. */
export function markThreadReadLocally(a: Agenda, threadId: string): boolean {
  const m = a.mail;
  if (!m) return false;
  const row = m.all?.find((x) => x.id === threadId);
  if (!row || !row.unread) return false;
  row.unread = false;
  m.unread = Math.max(0, m.unread - 1);
  return true;
}

/** Called after a source item is marked 확인 완료. Null = nothing to do (not mail, option off). */
export async function onMailReviewed(key: string, cfg: NedConfig, run?: Parameters<typeof startSendJob>[2]): Promise<MarkReadOutcome | null> {
  if (!key.startsWith("mail:") || cfg.actions.gmail_mark_read !== true) return null;
  const threadId = key.slice("mail:".length);
  if (!GMAIL_THREAD_ID.test(threadId)) return { skipped: "invalid", detail: `not a Gmail thread id: ${threadId.slice(0, 60)}` };

  try {
    patchAgenda((a) => void markThreadReadLocally(a, threadId));
  } catch (e) {
    log(`mark-read: optimistic agenda patch failed — ${String(e).slice(0, 200)}`);
  }

  const req: SendRequest = { source: "email", mode: "mark_read", text: "", ref: { thread_id: threadId } };
  const spent = todayCost();
  if (spent >= cfg.agenda_daily_budget_usd) {
    const detail = `skipped: today's spend $${spent.toFixed(2)} ≥ budget $${cfg.agenda_daily_budget_usd} (config.agenda_daily_budget_usd)`;
    log(`mark-read: ${threadId} ${detail}`);
    appendActionLog({ ts: new Date().toISOString(), source: req.source, mode: req.mode, action: "skipped:budget", ref: req.ref, text: "", ok: false, result: detail });
    return { skipped: "budget", detail };
  }

  const st = run ? await startSendJob(req, cfg, run) : await startSendJob(req, cfg);
  if (st.kind === "already_sent") return { skipped: "already", detail: st.sent.detail };
  if (st.kind === "sync") return st.result.ok ? {} : { skipped: "invalid", detail: st.result.detail };
  if (st.kind === "need_confirm") return { skipped: "invalid", detail: st.need.reasons.join(" · ") }; // mark_read is not a send: rules never hold it (send-rules.ts UNRULED_MODES)
  return { job_id: st.job.id, started_at: new Date(st.job.started_at).toISOString() };
}
