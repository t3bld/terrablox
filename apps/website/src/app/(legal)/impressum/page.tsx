import type { Metadata } from "next";
import { filled, LEGAL_LAST_UPDATED, OPERATOR } from "@/lib/legal";
import { GITHUB_URL, LICENSE_URL } from "@/lib/links";

export const metadata: Metadata = {
  title: "Legal notice — Terrablox",
  // No domain named. Every deployment is somebody else's hosting, so a concrete
  // host in the description would be wrong on all but one of them.
  description: "Provider identification pursuant to § 5 DDG for this website.",
};

/**
 * The provider identification required by § 5 DDG.
 *
 * § 5 of the Digitale-Dienste-Gesetz, not § 5 TMG: the TMG's provider obligations
 * moved to the DDG in May 2024, and "Angaben gemäß § 5 TMG" is now a citation of a
 * provision that no longer exists.
 *
 * Why this site needs one at all, given that the product is self-hosted: the duty
 * attaches to the *website*, not to the software it advertises. § 5 DDG covers
 * digital services offered on a business basis, and a site that markets a product and
 * links to a commercial enquiry is exactly that. That the tool runs on the reader's
 * own machine changes nothing about who is publishing this page.
 *
 * Written in English, with the German statutes named in German alongside their
 * translation. Both halves are deliberate: the obligation is German and its terms of
 * art do not survive translation — a reader checking § 5 DDG needs the citation as it
 * is written in the law — while the heading keeps "Impressum" beside "Legal notice"
 * because German case law is about whether the notice is *recognisable*, and
 * "Impressum" is the word that has been held to make it so.
 *
 * Blocks whose data is still a placeholder are omitted rather than rendered with the
 * marker text, so the page never states something untrue. Nothing announces the
 * omission any more, since the layout's banner was removed.
 */
export default function ImpressumPage() {
  const register = OPERATOR.register;
  const dpo = OPERATOR.dataProtectionOfficer;

  return (
    <>
      <h1 className="font-semibold text-3xl tracking-tight">
        Legal notice (Impressum)
      </h1>
      <p className="text-muted-foreground">
        Information pursuant to § 5 of the German Digital Services Act
        (Digitale-Dienste-Gesetz, DDG).
      </p>

      <h2>Provider</h2>
      <p>
        {filled(OPERATOR.name) ?? <em>David Theobald</em>}
        <br />
        {OPERATOR.country}
      </p>

      {filled(OPERATOR.representedBy) ? (
        <>
          <h2>Represented by</h2>
          <p>{filled(OPERATOR.representedBy)}</p>
        </>
      ) : null}

      <h2>Contact</h2>
      <p>
        {filled(OPERATOR.email) ? (
          <>
            Email: <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>
          </>
        ) : (
          <em>Email address missing</em>
        )}
        {filled(OPERATOR.phone) ? (
          <>
            <br />
            Phone: {filled(OPERATOR.phone)}
          </>
        ) : null}
      </p>

      {register ? (
        <>
          <h2>Commercial register</h2>
          <p>
            Register court: {register.court}
            <br />
            Register number: {register.number}
          </p>
        </>
      ) : null}

      {filled(OPERATOR.vatId) ? (
        <>
          <h2>VAT identification number</h2>
          <p>
            VAT identification number pursuant to § 27a of the German VAT Act
            (Umsatzsteuergesetz):
            <br />
            {filled(OPERATOR.vatId)}
          </p>
        </>
      ) : null}

      {filled(OPERATOR.editorialResponsible) ? (
        <>
          <h2>Responsible for editorial content</h2>
          <p>
            Responsible for journalistic and editorial content pursuant to § 18
            (2) of the German Interstate Media Treaty (Medienstaatsvertrag,
            MStV):
            <br />
            {filled(OPERATOR.editorialResponsible)}
            <br />
            {filled(OPERATOR.street)}
            <br />
            {filled(OPERATOR.city)}
          </p>
        </>
      ) : null}

      {dpo ? (
        <>
          <h2>Data protection officer</h2>
          <p>
            {dpo.name}
            <br />
            <a href={`mailto:${dpo.email}`}>{dpo.email}</a>
          </p>
        </>
      ) : null}

      <h2>Consumer dispute resolution</h2>
      <p>
        We are neither obliged nor willing to take part in dispute resolution
        proceedings before a consumer arbitration board (§ 36 of the German Act
        on Consumer Dispute Resolution, Verbraucherstreitbeilegungsgesetz).
      </p>

      <h2>About the software on this site</h2>
      <p>
        Terrablox is an open source project licensed under the{" "}
        <a href={LICENSE_URL} rel="noreferrer noopener" target="_blank">
          AGPL-3.0
        </a>
        . The source code is{" "}
        <a href={GITHUB_URL} rel="noreferrer noopener" target="_blank">
          on GitHub
        </a>
        .
      </p>
      <p>
        This website advertises the software but does not operate it: Terrablox
        is self-hosted only and runs on your own infrastructure, with your own
        database and your own AWS account. You are responsible for any instance
        you run — we have no access to it and receive no data from it. This
        legal notice therefore concerns this website alone.
      </p>
      <p>
        The software is provided without warranty; its extent follows from the
        licence. The providers of linked external sites are responsible for
        their content.
      </p>

      <hr />
      <p className="text-muted-foreground text-sm">
        Last updated: {LEGAL_LAST_UPDATED}
      </p>
    </>
  );
}
