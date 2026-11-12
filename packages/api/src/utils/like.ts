/** Escapes LIKE/ILIKE wildcards so user input is matched literally (Prisma's `contains` does not escape them). */
export function likeEscape(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}
