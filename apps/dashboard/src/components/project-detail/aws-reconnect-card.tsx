"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@terrablox/ui/card";
import { useToast } from "@terrablox/ui/toast";
import { Loader2, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { AwsQuickReconnect } from "@/components/account/aws-quick-reconnect";
import { AwsSsoConnect } from "@/components/account/aws-sso-connect";
import type { PreviousSignIn } from "@/lib/aws/project-connection";

/**
 * Sign back in to AWS, for a project whose deployment is already set up.
 *
 * Only the sign-in. The setup wizard would walk a finished project through
 * steps it has already done, while all that lapsed is the session. Once the
 * account is attached again the page's AWS state turns connected and the tab
 * shows its usual content.
 *
 * When the project knows how it signed in last, that is one click and a device
 * code. The full form, with portal, account and role, is only for a project
 * that does not, or for someone who asks for it.
 */
export function AwsReconnectCard({
  onAttach,
  signIn = null,
}: {
  onAttach: (accountId: string) => Promise<void>;
  signIn?: PreviousSignIn | null;
}) {
  const toast = useToast();
  const [attaching, setAttaching] = useState(false);
  const [fullForm, setFullForm] = useState(false);

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="text-base">Connect to AWS</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
          <p className="flex items-start gap-2 font-medium">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            The AWS session has expired. Sign in again to carry on.
          </p>
        </div>

        {signIn && !fullForm ? (
          <AwsQuickReconnect
            onChooseOther={() => setFullForm(true)}
            onConnected={onAttach}
            signIn={signIn}
          />
        ) : attaching ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" />
            Connecting…
          </p>
        ) : (
          <AwsSsoConnect
            defaultStartUrl={signIn?.startUrl ?? null}
            onConnected={(created) => {
              if (!created.accountId) {
                toast.error("That sign-in did not report an account id.");
                return;
              }
              setAttaching(true);
              onAttach(created.accountId)
                .catch((err: unknown) => {
                  toast.error(
                    err instanceof Error
                      ? err.message
                      : "Could not attach that account.",
                  );
                })
                .finally(() => setAttaching(false));
            }}
            usesSessionOnly
          />
        )}
      </CardContent>
    </Card>
  );
}
