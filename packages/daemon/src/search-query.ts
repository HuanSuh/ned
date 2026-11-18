/**
 * ⌘K 검색 — matching + 검색 키(연산자) parser + filters + autocomplete helpers. Pure (no imports, no I/O): this file is
 * the single definition, public/app/features/searchq.js a line-for-line copy; test/search-query-shared.test.ts runs both
 * on the same case table, so a change here must be made there too.
 *
 * Query syntax (keys case-insensitive, a value with spaces in double quotes — from:"서 지수"):
 *  - source:<값> / in:<값>  slack·슬랙 · mail·메일·gmail · jira·지라 · github·깃허브·gh · calendar·일정·캘린더 · session·세션 ·
 *                           briefing·브리핑 · todo·할일 · draft·초안 · event·이벤트·타임라인 · settings·설정 · attention·주의
 *  - from:<이름>            people only (Slack 보낸 이, 메일 발신자, GitHub 작성자) — substring, case-insensitive, spaces
 *                           ignored ("서 지수/팀X" ← from:서지수), 초성 (from:ㅅㅈㅅ). Jira 는 agenda 데이터에 사람 필드
 *                           (담당자·보고자)가 없어 from: 대상 아님.
 *  - channel:<채널> / #채널  Slack channel, substring, case-insensitive (#123 — digits only — stays a word: PR numbers;
 *                           a quoted "#foo" is a plain word too)
 *  - days:N · after:<날짜> · before:<날짜>   날짜 = YYYY-MM-DD · MM/DD · M/D, local; no year → this year, or last year
 *                           when this year's date is more than YEARLESS_AHEAD_DAYS (60) days ahead.
 *                           after = on/after that day, before = before that day.
 *  - is:open · is:done (✓ 처리) · is:mine (내가 쓴 것 — only items whose data says so)
 * Same key twice = OR (source:슬랙 source:메일); different keys = AND. An unknown key / bad value (foo:bar,
 * source:없는것, after:13/45) is not used as a filter but searched as a word (필터로 쓰지 않고 검색어로 찾음 — the
 * result count doesn't suddenly drop to 0) and shows a grey chip.
 * A known key with no value yet (`from:` while typing) is ignored. Remaining words score as before (초성 included);
 * keys without words = filter only, newest first.
 */

// ---------- matching ----------

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
export const norm = (s: unknown): string => String(s ?? "").normalize("NFC").toLowerCase();
/** Hangul syllables → their initial consonant (초성); everything else unchanged. */
export function chosung(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 0xac00 && c <= 0xd7a3 ? CHO[Math.floor((c - 0xac00) / 588)] : ch;
  }
  return out;
}
export const isCho = (t: string): boolean => /^[ㄱ-ㅎ]+$/.test(t);
const WORD_SEP = /[\s\-_/#@:.,()[\]<>"'·|]/;

/** 6 = field starts with token, 4 = a word starts with it, 2 = substring, 1.5 = 초성 match, 0 = none. */
export function tokenScore(text: string, tok: string): number {
  if (!text) return 0;
  if (text.startsWith(tok)) return 6;
  let i = text.indexOf(tok);
  if (i >= 0) {
    for (; i >= 0; i = text.indexOf(tok, i + 1)) if (WORD_SEP.test(text[i - 1] ?? " ")) return 4;
    return 2;
  }
  if (isCho(tok) && chosung(text).includes(tok)) return 1.5;
  return 0;
}

/** Plain whitespace tokens (no keys) — lower-cased, max 8. */
export function tokenize(q: string): string[] {
  return norm(q).split(/\s+/).filter(Boolean).slice(0, 8);
}

/** Fields: [text, weight]. Every token must match some field (AND); score = Σ best weight×tokenScore + recency. */
export function scoreFields(fields: Array<[unknown, number]>, toks: string[], ts: number | null | undefined, now = Date.now()): number {
  if (!toks.length) return 0;
  const f = fields.map(([t, w]) => [norm(t), w] as const).filter(([t]) => t);
  let total = 0;
  for (const tok of toks) {
    let best = 0;
    for (const [t, w] of f) best = Math.max(best, tokenScore(t, tok) * w);
    if (!best) return 0;
    total += best;
  }
  if (ts) {
    const days = Math.abs(now - ts) / 86_400_000;
    total += days < 1 ? 2 : days < 7 ? 1 : 0;
  }
  return total;
}

// ---------- keys ----------

/** Source value (lower-case, spaces removed) → canonical source. The first alias of each is what autocomplete inserts. */
export const SOURCE_ALIASES: Record<string, string[]> = {
  slack: ["슬랙", "slack"],
  mail: ["메일", "gmail", "mail", "email", "이메일"],
  jira: ["지라", "jira"],
  github: ["깃허브", "github", "gh", "깃헙"],
  calendar: ["일정", "캘린더", "calendar", "cal"],
  session: ["세션", "session", "sessions"],
  briefing: ["브리핑", "briefing", "briefings"],
  todo: ["할일", "todo", "todos"],
  draft: ["초안", "draft", "drafts"],
  event: ["이벤트", "타임라인", "event", "events", "timeline"],
  settings: ["설정", "settings", "setting"],
  attention: ["주의", "attention"],
};
export const SOURCE_LABEL: Record<string, string> = {
  slack: "Slack", mail: "메일", jira: "Jira", github: "GitHub", calendar: "일정", session: "세션", briefing: "브리핑",
  todo: "할 일", draft: "초안", event: "타임라인 이벤트", settings: "설정", attention: "주의 항목",
};
const SOURCE_OF: Record<string, string> = Object.fromEntries(Object.entries(SOURCE_ALIASES).flatMap(([k, vs]) => vs.map((v) => [v, k])));
const IS_OF: Record<string, "open" | "done" | "mine"> = {
  open: "open", 열림: "open", 미처리: "open",
  done: "done", 완료: "done", 처리: "done", 확인: "done",
  mine: "mine", 내것: "mine", 내꺼: "mine",
};
const IS_LABEL = { open: "열림", done: "✓ 처리됨", mine: "내 것" } as const;
export const QUERY_KEYS = ["source", "in", "from", "channel", "days", "after", "before", "is"] as const;
const KNOWN = new Set<string>(QUERY_KEYS);
const DAY = 86_400_000;
/** A yearless date further ahead than this is last year's (after:12/31 typed in January); closer = this year. */
export const YEARLESS_AHEAD_DAYS = 60;

export interface QueryChip {
  /** Key as typed, lower-cased ("#" for the #채널 form). */
  key: string;
  value: string;
  label: string;
  /** false = 인식 못 함 (grey): not used as a filter, searched as a plain word. */
  ok: boolean;
  /** [start, end) of the token in the raw query (chip ✕ removes it). */
  start: number;
  end: number;
}
export interface QueryFilters {
  sources: string[];
  from: string[];
  channel: string[];
  after: number | null;
  before: number | null;
  open: boolean;
  done: boolean;
  mine: boolean;
}
export interface ParsedQuery {
  terms: string[];
  filters: QueryFilters;
  chips: QueryChip[];
  /** Any recognized key (a key-only query lists newest first). */
  active: boolean;
}
/** The structured candidate fields the filters read (separate from the weighted text fields). */
export interface FilterFields {
  type: string;
  /** Source kind (slack / mail / jira / github / calendar / session / briefing / todo / draft / event / settings / attention). */
  src?: string;
  /** Sender-ish names: Slack 보낸 이, 메일 발신자, GitHub 작성자. Jira rows carry no person fields → none. */
  people?: string[];
  channel?: string;
  ts: number | null;
  /** ✓ 처리 (attention reviewed, todo done, source item ✓ mark); undefined = not a thing that gets done. */
  done?: boolean;
  /** Written by me — only when the data says so. */
  mine?: boolean;
}

interface Span { start: number; end: number; text: string }
/** Whitespace-separated tokens; a double quote opens a run that may contain spaces (unclosed → to the end). */
export function spans(q: string): Span[] {
  const out: Span[] = [];
  const n = q.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(q[i])) i++;
    if (i >= n) break;
    const start = i;
    let inQ = false;
    while (i < n && (inQ || !/\s/.test(q[i]))) {
      if (q[i] === "\"") inQ = !inQ;
      i++;
    }
    out.push({ start, end: i, text: q.slice(start, i) });
  }
  return out;
}
const unquote = (s: string): string => s.replace(/^"/, "").replace(/"$/, "");
const compact = (s: string): string => norm(s).replace(/\s+/g, "");
const two = (n: number) => String(n).padStart(2, "0");

/** YYYY-MM-DD · MM/DD · M/D → local midnight (ms), null when invalid. No year: this year, last year if > 60 days ahead. */
export function parseDay(v: string, now = Date.now()): number | null {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v.trim());
  let y: number, mo: number, d: number, yearless = false;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = /^(\d{1,2})\/(\d{1,2})$/.exec(v.trim()))) {
    [y, mo, d] = [new Date(now).getFullYear(), Number(m[1]), Number(m[2])];
    yearless = true;
  } else return null;
  const at = (yy: number) => {
    const t = new Date(yy, mo - 1, d);
    return t.getFullYear() === yy && t.getMonth() === mo - 1 && t.getDate() === d ? t.getTime() : null;
  };
  const today = new Date(now);
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  let t = at(y);
  if (yearless && (t == null || t > todayStart + YEARLESS_AHEAD_DAYS * DAY)) t = at(y - 1);
  return t;
}
const dayLabel = (t: number, now: number) => {
  const d = new Date(t);
  return d.getFullYear() === new Date(now).getFullYear() ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

export function parseQuery(q: string, now = Date.now()): ParsedQuery {
  const f: QueryFilters = { sources: [], from: [], channel: [], after: null, before: null, open: false, done: false, mine: false };
  const terms: string[] = [];
  const chips: QueryChip[] = [];
  const word = (s: string) => {
    for (const t of norm(s).split(/\s+/)) if (t) terms.push(t);
  };
  const add = <T>(arr: T[], v: T) => {
    if (!arr.includes(v)) arr.push(v);
  };
  for (const sp of spans(String(q ?? ""))) {
    const t = sp.text;
    const chip = (key: string, value: string, label: string, ok: boolean) => chips.push({ key, value, label, ok, start: sp.start, end: sp.end });
    const km = /^([A-Za-z]+):([\s\S]*)$/.exec(t);
    if (km && !km[2].startsWith("//")) {
      const key = km[1].toLowerCase(), raw = unquote(km[2]), val = raw.trim();
      if (!KNOWN.has(key)) {
        word(t);
        if (val) chip(key, val, `${t} · 인식 못 함`, false);
        continue;
      }
      if (!val) continue; // `from:` while typing
      let label = "";
      if (key === "source" || key === "in") {
        const s = SOURCE_OF[compact(val)];
        if (s) { add(f.sources, s); label = `출처: ${SOURCE_LABEL[s]}`; }
      } else if (key === "from") {
        const v = compact(val).replace(/^@+/, "");
        if (v) { add(f.from, v); label = `보낸 사람: ${val}`; }
      } else if (key === "channel") {
        const v = norm(val).replace(/^#+/, "").trim();
        if (v) { add(f.channel, v); label = `채널: #${val.replace(/^#+/, "")}`; }
      } else if (key === "days") {
        const n = /^\d{1,4}$/.test(val) ? Number(val) : NaN;
        if (n >= 1 && n <= 3650) { const a = now - n * DAY; f.after = f.after == null ? a : Math.max(f.after, a); label = `최근 ${n}일`; }
      } else if (key === "after" || key === "before") {
        const d = parseDay(val, now);
        if (d != null) {
          if (key === "after") f.after = f.after == null ? d : Math.max(f.after, d);
          else f.before = f.before == null ? d : Math.min(f.before, d);
          label = `${dayLabel(d, now)} ${key === "after" ? "이후" : "이전"}`;
        }
      } else if (key === "is") {
        const v = IS_OF[compact(val)];
        if (v) { f[v] = true; label = IS_LABEL[v]; }
      }
      if (label) chip(key, val, label, true);
      else { word(t); chip(key, val, `${t} · 인식 못 함`, false); }
      continue;
    }
    const hm = /^#([\s\S]+)$/.exec(t);
    if (hm && !/^\d+$/.test(hm[1])) {
      const v = norm(unquote(hm[1])).replace(/^#+/, "").trim();
      if (v) { add(f.channel, v); chip("#", unquote(hm[1]), `채널: #${unquote(hm[1]).replace(/^#+/, "")}`, true); continue; }
    }
    word(unquote(t));
  }
  const active = chips.some((c) => c.ok);
  return { terms: terms.slice(0, 8), filters: f, chips, active };
}

/** "서 지수/팀X" ← "서지수", "지수", "ㅅㅈㅅ" (v already compact). */
export function personMatch(person: unknown, v: string): boolean {
  const p = compact(String(person ?? "")).replace(/^@+/, "");
  if (!p || !v) return false;
  return p.includes(v) || (isCho(v) && chosung(p).includes(v));
}

export function matchFilters(c: FilterFields, f: QueryFilters): boolean {
  if (f.sources.length && !f.sources.includes(c.src ?? "") && !f.sources.includes(c.type)) return false;
  if (f.from.length && !(c.people ?? []).some((p) => f.from.some((v) => personMatch(p, v)))) return false;
  if (f.channel.length) {
    const ch = norm(c.channel ?? "").replace(/^#+/, "");
    if (!ch || !f.channel.some((v) => ch.includes(v))) return false;
  }
  if (f.after != null && (c.ts == null || c.ts < f.after)) return false;
  if (f.before != null && (c.ts == null || c.ts >= f.before)) return false;
  if (f.open !== f.done && c.done !== f.done) return false;
  if (f.mine && c.mine !== true) return false;
  return true;
}

/**
 * Filter + score + rank. Words → every word must match (scoreFields), best first; keys only → newest first (score 0).
 * Neither → []. Returns the candidates with `score` (fields left in place).
 */
export function runQuery<T extends FilterFields & { fields: Array<[unknown, number]> }>(cands: T[], q: string | ParsedQuery, now = Date.now()): Array<T & { score: number }> {
  const pq = typeof q === "string" ? parseQuery(q, now) : q;
  if (!pq.terms.length && !pq.active) return [];
  const out: Array<T & { score: number }> = [];
  for (const c of cands) {
    if (!matchFilters(c, pq.filters)) continue;
    let score = 0;
    if (pq.terms.length) {
      score = scoreFields(c.fields, pq.terms, c.ts, now);
      if (!score) continue;
    }
    out.push({ ...c, score });
  }
  return out.sort((a, b) => b.score - a.score || (b.ts ?? 0) - (a.ts ?? 0));
}

// ---------- autocomplete ----------

export type AcKind = "from" | "source" | "channel";
export interface AcContext { kind: AcKind; key: string; prefix: string; start: number; end: number; hash: boolean }
export interface AcItem { value: string; label: string; count: number }

/** The key token the caret is typing in (from: / source: / in: / channel: / #), else null. */
export function acContext(q: string, caret: number): AcContext | null {
  const sp = spans(q).find((s) => s.start < caret && caret <= s.end);
  if (!sp) return null;
  const t = q.slice(sp.start, caret);
  let m = /^([A-Za-z]+):"?([^"]*)$/.exec(t);
  if (m) {
    const key = m[1].toLowerCase();
    const kind: AcKind | null = key === "from" ? "from" : key === "source" || key === "in" ? "source" : key === "channel" ? "channel" : null;
    return kind ? { kind, key, prefix: m[2], start: sp.start, end: sp.end, hash: false } : null;
  }
  if ((m = /^#([^\s"]*)$/.exec(t))) return { kind: "channel", key: "#", prefix: m[1], start: sp.start, end: sp.end, hash: true };
  return null;
}

/** Up to 8 suggestions: people / channels by frequency in `cands`, or the source list. */
export function acSuggest(ctx: AcContext, cands: FilterFields[], max = 8): AcItem[] {
  const pre = ctx.prefix.trim();
  if (ctx.kind === "source") {
    const p = compact(pre);
    return Object.keys(SOURCE_ALIASES)
      .filter((k) => !p || SOURCE_ALIASES[k].some((a) => a.startsWith(p)))
      .map((k) => ({ value: SOURCE_ALIASES[k][0], label: SOURCE_LABEL[k], count: 0 }))
      .slice(0, max);
  }
  const counts = new Map<string, number>();
  for (const c of cands) {
    const vals = ctx.kind === "from" ? (c.people ?? []) : c.channel ? [c.channel] : [];
    for (const raw of vals) {
      const v = String(raw ?? "").replace(/\s+/g, " ").trim().replace(ctx.kind === "channel" ? /^#+/ : /^$/, "");
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  const want = ctx.kind === "from" ? compact(pre).replace(/^@+/, "") : norm(pre).replace(/^#+/, "");
  return [...counts]
    .filter(([v]) => !want || (ctx.kind === "from" ? personMatch(v, want) : norm(v).includes(want)))
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, max)
    .map(([v, n]) => ({ value: v, label: ctx.kind === "channel" ? `#${v}` : v, count: n }));
}

/**
 * The value being typed is already complete — don't open the list: a source alias (source:slack = 슬랙), or exactly one
 * of the suggestions (from:서지수 even when 서지수/팀X is also offered; #팀-매출).
 */
export function acSettled(ctx: AcContext, items: AcItem[]): boolean {
  const pre = ctx.prefix.trim();
  if (!pre) return false;
  if (ctx.kind === "source") return !!SOURCE_OF[compact(pre)];
  if (ctx.kind === "from") {
    const v = compact(pre).replace(/^@+/, "");
    return items.some((it) => compact(it.value).replace(/^@+/, "") === v);
  }
  const v = norm(pre).replace(/^#+/, "");
  return items.some((it) => norm(it.value) === v);
}

/** Replace the token being typed with the chosen value (quoted when it has spaces) + a space. */
export function acApply(q: string, ctx: AcContext, value: string): { q: string; caret: number } {
  const v = /\s/.test(value) ? `"${value}"` : value;
  const ins = `${ctx.hash ? "#" : `${ctx.key}:`}${v} `;
  const rest = q.slice(ctx.end).replace(/^\s+/, "");
  return { q: q.slice(0, ctx.start) + ins + rest, caret: ctx.start + ins.length };
}

/** The query without one chip's token. */
export function removeChip(q: string, chip: Pick<QueryChip, "start" | "end">): string {
  const a = q.slice(0, chip.start).replace(/\s+$/, ""), b = q.slice(chip.end).replace(/^\s+/, "");
  return a && b ? `${a} ${b}` : a || b;
}
