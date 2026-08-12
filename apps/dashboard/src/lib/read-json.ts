/**
 * Reads a JSON body without letting an empty response masquerade as a parse error.
 *
 * A route that crashes answers with a status and no body at all, and `res.json()`
 * reports that as "Unexpected end of JSON input" — a message about our parser
 * rather than about what failed, which sends people looking in the wrong place.
 */
export async function readJson<T extends { error?: string }>(
  res: Response,
): Promise<T> {
  const text = await res.text();

  if (!text.trim()) {
    return {
      error: `The server answered ${res.status} without any details. Check the server log.`,
    } as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return {
      error: `The server answered ${res.status} with something that is not JSON.`,
    } as T;
  }
}
