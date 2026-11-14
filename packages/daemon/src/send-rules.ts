/**
 * 보내기 규칙 (config.actions.rules): who a send goes to → allow / confirm / block, first matching rule wins.
 *
 * The target of a send, per rule source (case-insensitive, `*` wildcard only — no regex):
 * - slack: the channel name (`#` ignored), the channel id, and the person's name (DM / the message author)
 * - mail: the recipient address (`@domain` matches every address at that domain)
 * - jira: the project key (ABC of ABC-123) · github: `owner/repo` · calendar: attendee addresses / `@domain`
 * - session: the worktree name
 * `external: true` = a recipient address outside config.actions.internal_domains (mail / calendar only — Slack, Jira,
 * GitHub and sessions have no address to judge, so an external rule never matches them; [] domains → never matches).
 * Read-only or label-only modes (jira `transitions`, mail `mark_read`) are not sends: no rule applies to them.
 */
import type { NedConfig, RuleSource, SendRule } from "./config.js";
import { githubTarget, jiraTarget, readDraft, sessionEvents, slackTarget, type DraftMeta } from "./drafts.js";
import type { SendRequest } from "./actions.js";
import { reduceSessions } from "./sessions.js";

/** Modes that do not send anything to anyone: rules and the review leave them alone. */
export const UNRULED_MODES: ReadonlySet<string> = new Set(["transitions", "mark_read"]);

export function ruleSourceOf(source: SendRequest["source"]): Exclude<RuleSource, "*"> {
  return source === "email" ? "mail" : source;
}

export interface SendTarget {
  /** Strings a rule `target` is compared with (already lower-case, `#` stripped). */
  names: string[];
  /** Recipient addresses (lower-case) — for `@domain` targets and the external check. */
  addresses: string[];
  /** One line for people / the review prompt: "#general · 김철수", "a@x.com", "ABC-12", … */
  label: string;
}

const ADDR_RE = /[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g;
const addrsIn = (...s: (string | undefined)[]) => [...new Set(s.flatMap((x) => (x ?? "").match(ADDR_RE) ?? []).map((a) => a.toLowerCase()))];
const clean = (s: string) => s.trim().replace(/^#/, "").toLowerCase();

/** The worktree name of a session (its newest hook event), else the ref title the dashboard sent. */
export function sessionWorktree(sessionId: string | undefined, fallback?: string): string {
  if (sessionId) {
    try {
      const s = reduceSessions(sessionEvents(sessionId), 0)[0];
      if (s?.worktree) return s.worktree;
    } catch {
      /* no events */
    }
  }
  return fallback ?? "";
}

/** Who / where `req` goes, from the request (and its draft's meta). */
export function sendTargetOf(req: SendRequest, meta?: DraftMeta): SendTarget {
  const m: DraftMeta = meta ?? (req.draft_id ? (readDraft(req.draft_id)?.meta ?? {}) : {});
  const ref = req.ref;
  switch (req.source) {
    case "slack": {
      const id = slackTarget(ref).channel_id ?? m.channel_id;
      // ref.title is "<#channel | DM | 그룹 DM> · <name>" (draftref.js slackRef); ref.channel may be a name instead of an id.
      const [where, who] = (ref.title ?? "").split(" · ").map((x) => x.trim());
      const chName = where?.startsWith("#") ? where : ref.channel && !/^[A-Z0-9]+$/.test(ref.channel) ? ref.channel : "";
      const names = [id, chName, who].filter((x): x is string => !!x).map(clean);
      return { names: [...new Set(names)], addresses: [], label: [chName || id, who].filter(Boolean).join(" · ") };
    }
    case "email": {
      const addresses = addrsIn(m.reply_to, m.reply_to ? undefined : ref.title);
      return { names: addresses, addresses, label: addresses.join(", ") || (ref.title ?? "") };
    }
    case "jira": {
      const key = jiraTarget(ref).key ?? m.issue_key;
      const project = key?.split("-")[0];
      return { names: project ? [project.toLowerCase()] : [], addresses: [], label: key ?? "" };
    }
    case "github": {
      const g = githubTarget(ref);
      const repo = g.repo ?? m.repo;
      const num = g.number ?? m.number;
      return { names: repo ? [repo.toLowerCase()] : [], addresses: [], label: repo ? `${repo}${num ? `#${num}` : ""}` : "" };
    }
    case "calendar": {
      const addresses = addrsIn(...(req.event?.attendees ?? []));
      return { names: addresses, addresses, label: req.event ? `${req.event.title}${addresses.length ? ` · ${addresses.join(", ")}` : ""}` : (ref.title ?? ref.event_id ?? "") };
    }
    case "session": {
      const wt = sessionWorktree(ref.session_id, ref.title);
      return { names: wt ? [wt.toLowerCase()] : [], addresses: [], label: wt };
    }
  }
}

/** `*`-only glob, case-insensitive, whole string. `#chan` → `chan`; `@acme.com` → `*@acme.com`. */
export function targetMatches(pattern: string, value: string): boolean {
  let p = clean(pattern);
  if (!p) return false;
  if (p.startsWith("@")) p = `*${p}`;
  const re = new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
  return re.test(value.toLowerCase());
}

const domainOf = (addr: string) => addr.slice(addr.lastIndexOf("@") + 1);
/** Is `addr` at one of the domains (or a subdomain of one)? */
const internal = (addr: string, domains: string[]) => domains.some((d) => domainOf(addr) === d || domainOf(addr).endsWith(`.${d}`));

/**
 * external: true → some recipient is outside internal_domains; false → every recipient is inside. Unknown (no addresses,
 * no internal_domains, or a source without addresses) → null: an external rule then does not match.
 */
export function isExternal(target: SendTarget, source: Exclude<RuleSource, "*">, domains: string[]): boolean | null {
  if (source !== "mail" && source !== "calendar") return null;
  if (!domains.length || !target.addresses.length) return null;
  return target.addresses.some((a) => !internal(a, domains));
}

export interface RuleMatch {
  /** 0-based position in config.actions.rules. */
  index: number;
  rule: SendRule;
}

/** The first rule that matches `req` (null = none → allow, today's behaviour). */
export function matchSendRule(req: SendRequest, cfg: Pick<NedConfig, "actions">, target?: SendTarget): RuleMatch | null {
  const rules = cfg.actions.rules ?? [];
  if (!rules.length || UNRULED_MODES.has(req.mode)) return null;
  const src = ruleSourceOf(req.source);
  let t = target;
  const tgt = () => (t ??= sendTargetOf(req));
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index];
    if (rule.source !== "*" && rule.source !== src) continue;
    if (rule.target && !tgt().names.some((n) => targetMatches(rule.target!, n))) continue;
    if (typeof rule.external === "boolean") {
      const ext = isExternal(tgt(), src, cfg.actions.internal_domains ?? []);
      if (ext === null || ext !== rule.external) continue;
    }
    return { index, rule };
  }
  return null;
}

/** "규칙 3 (메일 · @acme.com): 외부 메일은 한 번 더" — the reason line shown to the user. */
export function ruleReason(m: RuleMatch): string {
  const r = m.rule;
  const what = [r.source === "*" ? "모든 소스" : r.source, r.target, r.external === true ? "외부" : r.external === false ? "내부" : ""].filter(Boolean).join(" · ");
  return `규칙 ${m.index + 1} (${what})${r.note ? `: ${r.note}` : ""}`;
}
