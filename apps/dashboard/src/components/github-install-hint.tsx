"use client";

import { Button } from "@terrablox/ui/button";
import { Clock, Github } from "lucide-react";

/**
 * What to say when the answer is "GitHub has not been asked yet".
 *
 * A state that could not exist before Terrablox became a GitHub App. An OAuth
 * token reached every repository its owner reached, so an empty repository list
 * meant the person genuinely had none. Now it usually means the app is installed
 * nowhere, or was granted a set that does not include what they are looking for —
 * and neither is fixable inside this app, which is the reason this component is a
 * link rather than a message.
 *
 * Opens in a new tab on purpose: granting access is a detour, and the dialog
 * underneath is worth coming back to rather than losing.
 */
export function GithubInstallHint({
  installUrl,
  /** Names what the empty list was for, so the sentence is about their task. */
  what = "repositories",
  /** Set when the app is installed but the granted set is missing something. */
  installed = false,
  /**
   * When this person asked an organisation owner to approve the app, as ISO.
   *
   * The third state, and the one that used to be told as the first: a request that is
   * waiting is not an installation, so every picker reported "not installed yet" and
   * the obvious response — install it — filed a second request. The loop ended when an
   * owner happened to approve, not when the person did anything differently.
   */
  pendingRequestAt = null,
}: {
  installUrl: string;
  what?: string;
  installed?: boolean;
  pendingRequestAt?: string | null;
}) {
  // Outranks `installed`: somebody can have the app on their own account and a pending
  // request for an organisation, and the organisation is what they are looking at.
  if (pendingRequestAt) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="flex items-center gap-1.5 font-medium text-sm">
          <Clock aria-hidden className="h-4 w-4 shrink-0" />
          Waiting for an organisation owner
        </p>

        <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
          You asked to install Terrablox on an organisation you are not an owner
          of, so GitHub sent the request to someone who is. No {what} will
          appear here until they approve it — there is nothing further to do in
          Terrablox, and asking again only files another request.
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {/* Where the request is listed for the owner, and where the requester
              can see it is still open. Not the install page: sending them back
              there is what produced the loop. */}
          <Button asChild size="sm" variant="outline">
            <a
              href="https://github.com/settings/installations"
              rel="noreferrer noopener"
              target="_blank"
            >
              <Github className="mr-1.5 h-4 w-4" />
              Check on GitHub
            </a>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-muted/30 p-4">
      <p className="font-medium text-sm">
        {installed
          ? `Terrablox has no ${what} it can use yet`
          : "Terrablox is not installed on GitHub yet"}
      </p>

      <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
        {installed
          ? "The GitHub App is installed, but the repositories it was granted do not cover what you need. Adjust the selection on GitHub."
          : "Terrablox reaches only the repositories you grant it. Install the GitHub App and choose which ones."}
      </p>

      <Button asChild className="mt-3" size="sm" variant="outline">
        <a href={installUrl} rel="noreferrer noopener" target="_blank">
          <Github className="mr-1.5 h-4 w-4" />
          {installed ? "Change repository access" : "Install on GitHub"}
        </a>
      </Button>
    </div>
  );
}
