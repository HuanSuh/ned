/**
 * Where an action / draft was started: "chat" = a Ned Net 확인 카드 (gated by actions.chat_write too); "card" = a home
 * card row's ✎; "history" = a card's "지난 N일" 이력 row; "watch" = a 팔로업 channel card (row · 최근 대화 · 요약 줄);
 * "session" = 대시보드 세션 행의 답하기(빠른 버튼 · 한 줄 입력); "pet" = 데스크톱 펫 말풍선의 답하기.
 * Absent = older dashboard buttons / clients. Only "chat" changes gating — the rest is a label for the action log.
 */
export type ActionOrigin = "chat" | "card" | "history" | "watch" | "session" | "pet";
export const ACTION_ORIGINS: readonly ActionOrigin[] = ["chat", "card", "history", "watch", "session", "pet"];
/** `body.origin` → one of ACTION_ORIGINS or undefined (anything else is ignored). */
export const parseOrigin = (v: unknown): ActionOrigin | undefined => ((ACTION_ORIGINS as readonly unknown[]).includes(v) ? (v as ActionOrigin) : undefined);
