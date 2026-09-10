export const maximumFtsTerms = 32;

export function containsHan(query: string): boolean {
  return /\p{Script=Han}/u.test(query);
}

export function toFtsQuery(query: string): string | null {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, maximumFtsTerms) ?? [];
  if (terms.length === 0) {
    return null;
  }
  return terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ");
}
