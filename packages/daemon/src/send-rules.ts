/**
 * 보내기 규칙 (config.actions.rules): who a send goes to → allow / confirm / block, first matching rule wins.
 *
 * The target of a send comes only from what decides where it really goes (or what the daemon itself collected),
 * never from display text the client sent:
 * - slack: the channel id (permalink / ref.channel / draft meta). A channel name or a person's name counts only when
 *   Ned's own Slack data (agenda: items · all · watch · threads · DMs) ties it to that channel id — so a rule written
 *   with a name may not match a channel Ned has not seen; `block` is safest written with the channel id.
 * - mail: the draft's reply_to (draft meta — the address the reply goes to). No draft / no reply_to → no recipient.
 * - jira: the project key (ABC of ABC-123) · github: `owner/repo` · calendar `create`: the attendees
 *   (calendar `rsvp` carries no attendees — only source-wide rules apply to it) · session: the worktree name.
 * Target compare: case-insensitive, `*` wildcard only (linear glob, no regex), `#` ignored, `@domain` = any address there.
 *
 * external (mail / calendar only), fail closed: every recipient is parsed as a whole (address.ts — angle brackets,
 * one `@`, IDNA-normalized domain). An unreadable recipient, or no recipient at all, counts as external; one
 * external recipient makes the send external. Empty internal_domains → external rules match nothing. Slack / Jira /
 * GitHub / sessions have no address: external rules never match them.
 * Read-only or label-only modes (jira `transitions`, mail `mark_read`) are not sends: no rule applies to them.
 */
import { domainOf, parseAddress } from "./address.js";
import { readAgenda } from "./agenda.js";
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
  /** Strings a rule `target` is compared with (lower-case, `#` stripped). */
  names: string[];
  /** mail / calendar: each recipient as given → its parsed address (null = unreadable). [] = recipients unknown. */
  recipients: { raw: string; addr: string | null }[];
  /** One line for people / the review prompt: "#general · 김철수", "a@x.com", "ABC-12", … */
  label: string;
}

const clean = (s: string) => s.trim().replace(/^#/, "").toLowerCase();
const recipientsOf = (list: unknown[]) => list.filter((x): x is string => typeof x === "string" && !!x.trim()).map((raw) => ({ raw: raw.trim(), addr: parseAddress(raw) }));

// ---------------------------------------------------------------- Slack: channel id → names Ned itself has seen
export interface SlackDirEntry {
  /** "#name" as the agenda named the channel. */
  names: Set<string>;
  /** Message authors seen in that channel (DM partner for a DM). */
  people: Set<string>;
}
const SLACK_ID_IN_URL = /\/archives\/([A-Z0-9]+)\/p\d+/;

/** id → names / people from the agenda's Slack block (every object with a channel + a permalink or channel_id). */
export function buildSlackDirectory(slack: unknown): Map<string, SlackDirEntry> {
  const dir = new Map<string, SlackDirEntry>();
  const add = (id: string, name: string | undefined, person: string | undefined) => {
    const e = dir.get(id) ?? { names: new Set<string>(), people: new Set<string>() };
    if (name?.startsWith("#")) e.names.add(clean(name));
    if (person?.trim()) e.people.add(person.trim().toLowerCase());
    dir.set(id, e);
  };
  const walk = (node: unknown, channel: string | undefined, depth: number) => {
    if (!node || typeof node !== "object" || depth > 6) return;
    if (Array.isArray(node)) {
      for (const x of node) walk(x, channel, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const ch = typeof o.channel === "string" ? o.channel : channel;
    const id = typeof o.channel_id === "string" && /^[A-Z0-9]+$/.test(o.channel_id) ? o.channel_id : typeof o.url === "string" ? SLACK_ID_IN_URL.exec(o.url)?.[1] : undefined;
    if (id) add(id, ch, typeof o.from === "string" ? o.from : typeof o.root_from === "string" ? o.root_from : undefined);
    for (const v of Object.values(o)) if (v && typeof v === "object") walk(v, ch, depth + 1);
  };
  walk(slack, undefined, 0);
  return dir;
}

let slackDirFn: () => Map<string, SlackDirEntry> = () => {
  try {
    return buildSlackDirectory(readAgenda().slack);
  } catch {
    return new Map();
  }
};
/** Tests: swap the Slack directory (undefined → the agenda again). */
export function _setSlackDirectory(fn?: () => Map<string, SlackDirEntry>): void {
  slackDirFn = fn ?? (() => {
    try {
      return buildSlackDirectory(readAgenda().slack);
    } catch {
      return new Map();
    }
  });
}

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

/** Who / where `req` goes, from what decides it (draft meta, ids, the session's own events). */
export function sendTargetOf(req: SendRequest, meta?: DraftMeta): SendTarget {
  const m: DraftMeta = meta ?? (req.draft_id ? (readDraft(req.draft_id)?.meta ?? {}) : {});
  const ref = req.ref;
  switch (req.source) {
    case "slack": {
      const id = slackTarget(ref).channel_id ?? m.channel_id;
      if (!id) return { names: [], recipients: [], label: "" };
      const known = slackDirFn().get(id);
      const names = [id.toLowerCase(), ...(known?.names ?? [])];
      // The person in ref.title ("<#channel | DM> · <name>") counts only when Ned has seen them in that channel.
      const who = (ref.title ?? "").split(" · ")[1]?.trim().toLowerCase();
      if (who && known?.people.has(who)) names.push(who);
      const shown = [...(known?.names ?? [])][0];
      return { names: [...new Set(names)], recipients: [], label: [shown ? `#${shown}` : id, who && known?.people.has(who) ? who : ""].filter(Boolean).join(" · ") };
    }
    case "email": {
      const recipients = recipientsOf([m.reply_to]);
      return { names: recipients.flatMap((r) => (r.addr ? [r.addr] : [])), recipients, label: recipients.map((r) => r.addr ?? r.raw).join(", ") || "(받는 이 미상)" };
    }
    case "jira": {
      const key = jiraTarget(ref).key ?? m.issue_key;
      const project = key?.split("-")[0];
      return { names: project ? [project.toLowerCase()] : [], recipients: [], label: key ?? "" };
    }
    case "github": {
      const g = githubTarget(ref);
      const repo = g.repo ?? m.repo;
      const num = g.number ?? m.number;
      return { names: repo ? [repo.toLowerCase()] : [], recipients: [], label: repo ? `${repo}${num ? `#${num}` : ""}` : "" };
    }
    case "calendar": {
      const recipients = recipientsOf(req.event?.attendees ?? []);
      const names = recipients.flatMap((r) => (r.addr ? [r.addr] : []));
      return { names, recipients, label: req.event ? `${req.event.title}${names.length ? ` · ${names.join(", ")}` : ""}` : (ref.title ?? ref.event_id ?? "") };
    }
    case "session": {
      const wt = sessionWorktree(ref.session_id, ref.title);
      return { names: wt ? [wt.toLowerCase()] : [], recipients: [], label: wt };
    }
  }
}

/**
 * `*`-only glob, case-insensitive, whole string — linear greedy match (runs of `*` fold into one; no RegExp, so no
 * catastrophic backtracking). `#chan` → `chan`; `@acme.com` → `*@acme.com`.
 */
export function targetMatches(pattern: string, value: string): boolean {
  let p = clean(pattern).replace(/\*+/g, "*");
  if (!p) return false;
  if (p.startsWith("@")) p = `*${p}`;
  const v = value.toLowerCase();
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < v.length) {
    if (i < p.length && p[i] !== "*" && p[i] === v[j]) { i++; j++; }
    else if (i < p.length && p[i] === "*") { star = i++; mark = j; }
    else if (star >= 0) { i = star + 1; j = ++mark; }
    else return false;
  }
  while (i < p.length && p[i] === "*") i++;
  return i === p.length;
}

/** Is `addr` at one of the domains (or a subdomain of one)? */
const internal = (addr: string, domains: string[]) => domains.some((d) => domainOf(addr) === d || domainOf(addr).endsWith(`.${d}`));

/**
 * external (mail / calendar), fail closed: true when any recipient is outside internal_domains, unreadable, or there
 * is no recipient to judge; false only when every recipient is a readable internal address. null = not judged
 * (another source, or internal_domains empty) → an external rule does not match.
 */
export function isExternal(target: SendTarget, source: Exclude<RuleSource, "*">, domains: string[]): boolean | null {
  if (source !== "mail" && source !== "calendar") return null;
  if (!domains.length) return null;
  if (!target.recipients.length) return true;
  return target.recipients.some((r) => !r.addr || !internal(r.addr, domains));
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
