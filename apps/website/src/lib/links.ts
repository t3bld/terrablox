/**
 * Outbound addresses, in one place.
 *
 * The repository moving is a single edit here rather than a search across every
 * section that happens to link to it.
 */
export const GITHUB_URL = "https://github.com/t3bld/terrablox";
export const LICENSE_URL = `${GITHUB_URL}?tab=AGPL-3.0-1-ov-file`;

/**
 * The documentation, on this site rather than on GitHub.
 *
 * It used to point at `/tree/main/docs`, which sent a reader from a designed page
 * into a file listing. The Markdown still lives there and is still the source — the
 * pages under `/docs` are built from it — so this is a change of destination and not
 * of format. Relative, because the site is also served from a sub-path on a project
 * page, and Next prefixes it.
 */
export const DOCS_URL = "/docs";

/**
 * The legal pages, at the addresses a German reader would guess.
 *
 * Not under `/legal/`: § 5 DDG asks for the provider identification to be "leicht
 * erkennbar" and "unmittelbar erreichbar", and the footer link plus a top-level path
 * is the reading of that nobody argues with. Relative for the same reason as the
 * docs — a project page serves this site from a sub-path and Next prefixes it.
 */
export const IMPRESSUM_URL = "/impressum";
export const PRIVACY_URL = "/datenschutz";

/**
 * Where a commercial enquiry goes.
 *
 * This was a prefilled GitHub issue, chosen because it worked with nothing to set up
 * and could not bounce, with a note to swap it for `mailto:` once there was an address
 * to receive on. There is one now, so it has been swapped: a public issue tracker is a
 * poor place for somebody to describe their estate, which is exactly what a first
 * message about a migration contains.
 *
 * The subject is prefilled and the body is not. A subject line survives being ignored
 * and is what the recipient sorts on; a prefilled body full of our questions is a form
 * in a mail client, and it arrives before the sender has decided they want to write at
 * all.
 */
export const CONSULTING_EMAIL = "mail@davidtheobald.de";

export const CONSULTING_URL = `mailto:${CONSULTING_EMAIL}?subject=${encodeURIComponent(
  "Terrablox — working together",
)}`;
