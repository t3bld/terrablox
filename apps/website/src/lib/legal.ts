/**
 * The operator's own details, for the Impressum and the privacy policy.
 *
 * ⚠️ This is not legal advice, and the values below are placeholders. Both pages are
 * a scaffold built from the obligations that apply to *this* site — a German-operated
 * marketing site with a commercial enquiry link — and they have to be completed and
 * ideally reviewed by a lawyer before the site goes live. An Impressum with wrong
 * details is worse than a missing one: it is both an incorrect declaration and still
 * a missing declaration.
 *
 * Why one file: § 5 DDG and Art. 13 GDPR ask for overlapping information — the
 * controller in the privacy policy is the provider in the Impressum — and two pages
 * quoting the same address separately is two places to update and one to forget.
 *
 * Fill in every field marked `PLACEHOLDER`. Nothing announces that they are missing
 * any more — the banner that did was removed — so what remains is {@link filled},
 * which makes a page omit a block rather than print the marker. An incomplete page
 * therefore says less than the truth rather than something false, but it says it
 * quietly: check this file before publishing, because the site will not remind you.
 */

/** Marks a value that still has to be supplied. */
export const PLACEHOLDER = "PLACEHOLDER" as const;

export interface LegalEntity {
  /**
   * The full legal name, including the form of company.
   *
   * For a GmbH or UG this is the name as registered; for a sole trader it is the
   * person's own name. § 5 DDG asks for the name, not a brand — "Terrablox" on its
   * own is not enough if that is not what is on the register.
   */
  name: string;
  /**
   * The postal address, as separate lines.
   *
   * A postbox is not sufficient: § 5 DDG asks for the address at which the provider
   * is established, which has to be one where post can actually be served.
   */
  street: string;
  city: string;
  country: string;
  /**
   * Who represents the company, for anything other than a sole trader.
   *
   * Required for legal persons — the managing director of a GmbH or UG. Leave null
   * for a sole trader, where the name above is already the person.
   */
  representedBy: string | null;
  /** An address that is read. § 5 DDG requires a means of fast electronic contact. */
  email: string;
  /**
   * A phone number, if you publish one.
   *
   * Not mandatory: the CJEU held in C-298/07 that an email address plus another
   * route to a fast enquiry is enough, so a contact form or a second address also
   * satisfies it. Left optional for that reason.
   */
  phone: string | null;
  /** Commercial register court and number, for a registered company. Null otherwise. */
  register: { court: string; number: string } | null;
  /** VAT identification number under § 27a UStG, if one has been issued. */
  vatId: string | null;
  /**
   * Who is responsible for editorial content under § 18 (2) MStV.
   *
   * Applies where a site carries journalistic-editorial content — a blog, or arguably
   * the documentation here. Name and address; usually the same person as above, which
   * is why it is a name rather than a second address block.
   */
  editorialResponsible: string | null;
  /**
   * A data protection officer, if one had to be appointed.
   *
   * § 38 BDSG requires one from twenty people involved in automated processing, and
   * earlier in some cases. Most small operators have none, which is why null is the
   * expected value rather than a gap.
   */
  dataProtectionOfficer: { name: string; email: string } | null;
  /**
   * The supervisory authority for complaints under Art. 77 GDPR.
   *
   * The one for the federal state the company is established in. Naming it is not
   * strictly required — the right to complain is — but it is the difference between
   * a reader knowing their right and being able to use it.
   */
  supervisoryAuthority: { name: string; url: string } | null;
}

export const OPERATOR: LegalEntity = {
  name: "David Theobald",
  street: PLACEHOLDER,
  city: PLACEHOLDER,
  // Rendered verbatim on both pages, which are English, so this is too. The
  // registered address stays in whatever form post is actually addressed in.
  country: "Germany",
  representedBy: PLACEHOLDER,
  email: "mail@davidtheobald.de",
  phone: null,
  register: null,
  vatId: null,
  editorialResponsible: PLACEHOLDER,
  dataProtectionOfficer: null,
  supervisoryAuthority: null,
};

/**
 * The date the legal texts were last substantively changed.
 *
 * Shown on both pages. Kept by hand rather than derived from the build, because a
 * date that moves on every deployment tells a reader nothing about whether the terms
 * they are looking at have changed.
 */
export const LEGAL_LAST_UPDATED = "3 September 2026";

/** The host, named in the privacy policy because it is where the logs are. */
export const HOSTING_PROVIDER = {
  name: "GitHub, Inc.",
  address: "88 Colin P. Kelly Jr. Street, San Francisco, CA 94107, USA",
  service: "GitHub Pages",
  privacyUrl:
    "https://docs.github.com/site-policy/privacy-policies/github-privacy-statement",
} as const;

/** A value, or null when it is still a placeholder, so pages can omit a whole block. */
export function filled(value: string | null): string | null {
  return value === PLACEHOLDER || value === null ? null : value;
}
