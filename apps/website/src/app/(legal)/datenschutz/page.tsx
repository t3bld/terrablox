import type { Metadata } from "next";

import {
  filled,
  HOSTING_PROVIDER,
  LEGAL_LAST_UPDATED,
  OPERATOR,
} from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy policy — Terrablox",
  // No domain named, for the reason the legal notice gives: every deployment is
  // somebody else's hosting.
  description: "What data arises when you visit this site — and what does not.",
};

/**
 * The Art. 13 GDPR information duty, for a site that processes almost nothing.
 *
 * It is still required. The duty attaches as soon as personal data is processed, and
 * a static site processes at least one thing: the visitor's IP address, in the host's
 * server logs. That the site has no server of its own does not remove it, it only
 * moves it to GitHub — which is also why the third-country transfer has to be named.
 *
 * The text below is deliberately specific about what is *absent*, because on this
 * site the absences are the substance and they are all verifiable from the
 * repository: no analytics or tracking scripts (there is no such code, and the CSP in
 * `app/layout.tsx` pins `connect-src` to `'self'`), no cookies and no local storage
 * (nothing writes either), no forms (an enquiry goes to GitHub), and self-hosted
 * fonts (`next/font/google` downloads Inter at build time and serves it from this
 * origin, so the browser never contacts Google).
 *
 * English, with the GDPR cited by article. Unlike the legal notice this needs no
 * German term of art: the regulation is European and its English text is authentic,
 * so "privacy policy" is the whole title with nothing lost.
 *
 * Keep this in step with the code. If the site ever gains analytics, a form or an
 * embedded third party, this page stops being true on the same commit.
 */
export default function DatenschutzPage() {
  const dpo = OPERATOR.dataProtectionOfficer;
  const authority = OPERATOR.supervisoryAuthority;

  return (
    <>
      <h1 className="font-semibold text-3xl tracking-tight">Privacy policy</h1>
      <p className="text-muted-foreground">
        Information pursuant to Art. 13 of the General Data Protection
        Regulation (GDPR).
      </p>

      <h2>The short version</h2>
      <p>This website is a static site. It uses:</p>
      <ul>
        <li>no cookies,</li>
        <li>no tracking and no analytics tools,</li>
        <li>no advertising or social media scripts,</li>
        <li>
          no forms — an enquiry goes through GitHub, and therefore through a
          service you decide for yourself whether to use.
        </li>
      </ul>
      <p>
        Fonts are served with the page rather than fetched from someone else's
        server, so your browser opens no connection to a third party while you
        are reading this site. What does arise is the access data at the host —
        which the next section is about.
      </p>

      <h2>Controller</h2>
      <p>
        {filled(OPERATOR.name) ?? <em>Name of the controller missing</em>}
        <br />
        {OPERATOR.country}
        {filled(OPERATOR.email) ? (
          <>
            <br />
            Email: <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>
          </>
        ) : null}
      </p>

      {dpo ? (
        <p>
          Data protection officer: {dpo.name},{" "}
          <a href={`mailto:${dpo.email}`}>{dpo.email}</a>
        </p>
      ) : null}

      <h2>Hosting and server log files</h2>
      <p>
        This website is served as a static site through{" "}
        {HOSTING_PROVIDER.service}, a service of {HOSTING_PROVIDER.name},{" "}
        {HOSTING_PROVIDER.address}.
      </p>
      <p>
        When you open the page, your browser transmits technically necessary
        data which the host processes in log files. This includes in particular:
      </p>
      <ul>
        <li>your IP address,</li>
        <li>the date and time of access,</li>
        <li>the page or file requested,</li>
        <li>the volume of data transferred and the response status,</li>
        <li>the browser and operating system used,</li>
        <li>where applicable, the page visited before this one (referrer).</li>
      </ul>
      <p>
        <strong>Purpose and legal basis:</strong> this processing is necessary
        in order to deliver the page at all and to keep its operation and
        security intact. The legal basis is our legitimate interest in providing
        the site reliably and securely under Art. 6 (1) (f) GDPR. We do not
        evaluate this data and do not combine it with any other data.
      </p>
      <p>
        <strong>Transfer to the USA:</strong> {HOSTING_PROVIDER.name} is a
        company established in the USA and part of Microsoft. Your data may
        therefore be processed outside the European Union. Details of the
        processing and of the safeguards for the transfer are set out in{" "}
        <a
          href={HOSTING_PROVIDER.privacyUrl}
          rel="noreferrer noopener"
          target="_blank"
        >
          GitHub's privacy statement
        </a>
        .
      </p>
      <p>
        <strong>Retention:</strong> the log files are managed by the host. We
        have no access to them and store no access data ourselves.
      </p>

      <h2>External links</h2>
      <p>
        This site links outwards in several places, in particular to GitHub.
        Data is transmitted to the provider concerned only once you click such a
        link. Their own privacy policy governs that processing, and none of it
        is loaded in advance on this page.
      </p>

      <h2>If you run Terrablox yourself</h2>
      <p>
        Terrablox is self-hosted only. An instance you run does so on your
        infrastructure, with your database and your AWS account. For the data
        processed there you are the controller within the meaning of the GDPR,
        not us: we have no access to your instance, receive no data from it, and
        operate no service through which such data could reach us.
      </p>
      <p>
        Your instance talks directly to the providers you configure for it —
        GitHub for sign-in and repositories, GitHub Copilot for model requests,
        AWS for deployments. Those connections are between you and the provider
        in question. What data travels over them is described in the
        documentation.
      </p>

      <h2>Your rights</h2>
      <p>
        In respect of us you have the right of access (Art. 15 GDPR),
        rectification (Art. 16), erasure (Art. 17), restriction of processing
        (Art. 18), data portability (Art. 20), and the right to object to
        processing (Art. 21 GDPR).
      </p>
      <p>
        Independently of that, you may lodge a complaint with a data protection
        supervisory authority (Art. 77 GDPR).
        {authority ? (
          <>
            {" "}
            The authority responsible for us is{" "}
            <a href={authority.url} rel="noreferrer noopener" target="_blank">
              {authority.name}
            </a>
            .
          </>
        ) : null}
      </p>
      <p>
        Please note: a request for access to, or erasure of, the access data
        described above is one we cannot realistically meet, because we do not
        store that data ourselves and it is not available to us.
      </p>

      <h2>Changes</h2>
      <p>
        If this website changes technically, this policy changes with it. The
        version published here is the one that applies.
      </p>

      <hr />
      <p className="text-muted-foreground text-sm">
        Last updated: {LEGAL_LAST_UPDATED}
      </p>
    </>
  );
}
