import { distance } from "fastest-levenshtein";

/**
 * Fuzzy-matches a normalized employer name against a list of existing
 * canonical employer names. Pure function, no DB access — normalize.ts
 * is responsible for fetching the candidate list and acting on the result.
 *
 * Design intent (see normalize.ts / CLAUDE.md for the full reasoning):
 * a false merge (treating two different companies as one) silently
 * corrupts every aggregate that touches either of them and is invisible
 * in the UI. A missed merge just leaves two rows unresolved — annoying,
 * but visible and fixable later via a manual_override alias. So this
 * function is deliberately conservative: it would rather return
 * "needs_review" than guess wrong.
 */

export const AUTO_LINK_THRESHOLD = 0.95;
export const REVIEW_THRESHOLD = 0.85;

export type EmployerCandidate = {
  employerId: number;
  canonicalName: string;
};

export type MatchResult =
  | { decision: "auto_link"; employerId: number; canonicalName: string; confidence: number }
  | { decision: "needs_review"; employerId: number; canonicalName: string; confidence: number }
  | { decision: "no_match" };

function similarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1; // two empty strings — shouldn't happen in practice
  return 1 - distance(a, b) / maxLen;
}

export function findBestMatch(
  normalizedName: string,
  candidates: EmployerCandidate[]
): MatchResult {
  let best: { candidate: EmployerCandidate; score: number } | null = null;

  for (const candidate of candidates) {
    const score = similarity(normalizedName, candidate.canonicalName);
    if (!best || score > best.score) {
      best = { candidate, score };
    }
  }

  if (!best || best.score < REVIEW_THRESHOLD) {
    return { decision: "no_match" };
  }

  if (best.score >= AUTO_LINK_THRESHOLD) {
    return {
      decision: "auto_link",
      employerId: best.candidate.employerId,
      canonicalName: best.candidate.canonicalName,
      confidence: best.score,
    };
  }

  return {
    decision: "needs_review",
    employerId: best.candidate.employerId,
    canonicalName: best.candidate.canonicalName,
    confidence: best.score,
  };
}
