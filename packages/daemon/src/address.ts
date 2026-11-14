/**
 * One recipient string → a normalized address, or null when it cannot be read unambiguously.
 * Used by 보내기 규칙 (send-rules.ts: fail closed — an unreadable recipient counts as external) and by
 * calendar-create.ts (attendees are sent only in this normalized ASCII / punycode form).
 *
 * - `"A Kim" <a@x.com>` / `a@x.com` → the angle-bracket part, else the whole string (no regex scanning inside text)
 * - exactly one `@`; the domain is what follows it, lower-cased and IDNA-normalized (url.domainToASCII)
 * - local part: ASCII atext only (no `josé@…`), ≤ 64
 * - a non-ASCII domain that maps to plain ASCII without a punycode label (full-width `ａｃｍｅ.com`) is refused:
 *   it would read as `acme.com` while not being what the user typed
 */
import { domainToASCII } from "node:url";

const LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;
const ASCII_DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function parseAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  const angle = /<([^<>]*)>\s*$/.exec(s);
  if (angle) s = angle[1].trim();
  if (!s || s.length > 254 || /\s/.test(s)) return null;
  const at = s.indexOf("@");
  if (at <= 0 || at !== s.lastIndexOf("@")) return null;
  const local = s.slice(0, at);
  const dom = s.slice(at + 1).toLowerCase();
  if (!LOCAL.test(local) || !dom) return null;
  const ascii = domainToASCII(dom);
  if (!ascii || !ASCII_DOMAIN.test(ascii) || ascii.length > 253) return null;
  // eslint-disable-next-line no-control-regex
  if (/[^\x00-\x7f]/.test(dom) && !ascii.split(".").some((l) => l.startsWith("xn--"))) return null;
  return `${local.toLowerCase()}@${ascii}`;
}

/** The domain of a parseAddress() result. */
export const domainOf = (addr: string) => addr.slice(addr.lastIndexOf("@") + 1);
