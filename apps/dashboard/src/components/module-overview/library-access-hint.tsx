"use client";

import { Alert, AlertDescription, AlertTitle } from "@terrablox/ui/alert";
import { Button } from "@terrablox/ui/button";
import { ExternalLink, Library } from "lucide-react";
import type { ModuleLibraryStatus } from "./use-module-libraries";

/**
 * Non-blocking note for a library the user seems entitled to but cannot reach
 * yet. Only rendered when the server produced a hint, so people unrelated to the
 * library's organisation never see it.
 */
export function LibraryAccessHint({
  library,
}: {
  library: ModuleLibraryStatus;
}) {
  const { hint } = library;
  if (!hint) return null;

  const topics = library.topics.join(" and ");

  return (
    <Alert>
      <Library aria-hidden="true" className="h-4 w-4" />
      <AlertTitle>{library.name} modules are not available yet</AlertTitle>
      <AlertDescription className="space-y-2">
        <p className="text-sm text-muted-foreground">
          {hint.kind === "install"
            ? `Terrablox can't see any ${library.org} repositories for you. An organisation owner has to install the Terrablox GitHub App on ${library.org} and select the module repositories${topics ? ` (topics ${topics})` : ""}, and you need read access to them.`
            : `Terrablox is installed on ${library.org}, but none of the repositories it can reach for you carry ${topics ? `the topics ${topics}` : "the library's selection"}. Ask an organisation owner to add the module repositories to the installation.`}
        </p>
        <Button asChild size="sm" variant="outline">
          <a href={hint.url} rel="noopener noreferrer" target="_blank">
            {hint.kind === "install"
              ? "Install on GitHub"
              : "Change repository access"}
            <ExternalLink aria-hidden="true" className="ml-1.5 h-3.5 w-3.5" />
          </a>
        </Button>
      </AlertDescription>
    </Alert>
  );
}
