/**
 * A set of temporary AWS credentials, and what the SDK wants of it.
 *
 * These two lived in the app's `credentials.ts`, next to the code that *builds* a
 * session out of the database. That put a type and a three-line mapper behind a Prisma
 * import, and made every module that merely *uses* a session — CloudFormation, S3, IAM —
 * depend on how one is stored. Splitting them is what let this package exist.
 *
 * The direction to keep in mind: nothing here knows where a session comes from. The app
 * decrypts a stored role, or walks an SSO device flow, and hands the result in. That is
 * also why the package needs no `server-only` marker — it holds no secret of its own,
 * and the marker would make it unusable from a CLI.
 */

export interface AwsSessionCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  /** When the credentials stop working, so a caller can refuse rather than retry. */
  expiration: Date | null;
}

export interface ProjectAwsSession {
  credentials: AwsSessionCredentials;
  region: string;
  accountId: string | null;
  /** The connection that produced the session, for error messages. */
  connectionLabel: string;
}

/** The shape AWS SDK clients want, without leaking the expiry into callers. */
export function toClientCredentials(session: ProjectAwsSession) {
  return {
    accessKeyId: session.credentials.accessKeyId,
    secretAccessKey: session.credentials.secretAccessKey,
    sessionToken: session.credentials.sessionToken,
  };
}
