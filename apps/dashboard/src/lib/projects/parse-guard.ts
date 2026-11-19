/**
 * The last check before an edit is committed: every Terraform file it changed
 * must still parse.
 *
 * The editors in `@terrablox/terraform/hcl-edit` work on text, so a value they
 * are handed can still break the syntax around it. One broken file is worse than
 * one failed edit. Every later read of the project fails with it (the graph, the
 * cost estimate), and every later edit works on a file its scanner can no longer
 * follow. That is how one bad value once turned into duplicated `locals`
 * blocks: each following edit could not see the entries already there and
 * appended them again.
 *
 * So the rule is strict. An edit whose result does not parse is refused, also
 * when the file was already broken, because writing more into a file nothing can
 * read only makes it worse. Such a file has to be repaired in the repository.
 */

export class UnparseableEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnparseableEditError";
  }
}

/** Parses one file, resolving to the parser's message when it fails. */
export type TerraformParser = (
  path: string,
  content: string,
) => Promise<string | null>;

/** The real parser: the same one the graph and the cost service read with. */
export const hclParser: TerraformParser = async (path, content) => {
  const { parse } = await import("@cdktf/hcl2json");
  try {
    await parse(path, content);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

/**
 * Throws {@link UnparseableEditError} if an edited `.tf` file no longer parses.
 *
 * Only files the edit changed are parsed, so an unrelated broken file never
 * blocks an edit elsewhere.
 */
export async function assertEditParses(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
  parser: TerraformParser = hclParser,
): Promise<void> {
  for (const [path, content] of after) {
    if (!path.endsWith(".tf") || before.get(path) === content) continue;

    const problem = await parser(path, content);
    if (!problem) continue;

    const previous = before.get(path);
    const wasBroken =
      previous !== undefined && (await parser(path, previous)) !== null;

    throw new UnparseableEditError(
      wasBroken
        ? `${path} cannot be parsed, so it was not edited. Repair the file in the repository first: ${problem}`
        : `This edit would leave ${path} unparseable, so it was not committed: ${problem}`,
    );
  }
}
