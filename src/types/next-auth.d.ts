import "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      username: string;
      firstName: string;
      lastName: string;
      role: string;
      /**
       * The ConsentFormVersion.version this user last decided on for their
       * role, and their decision — null when they haven't decided on the
       * currently active version yet. See src/lib/consent.ts.
       */
      consentVersion: string | null;
      consentDecision: string | null;
    };
  }

  interface User {
    id: string;
    email: string;
    username: string;
    firstName: string;
    lastName: string;
    role: string;
    /** Absolute Unix timestamp selected when credentials are accepted. */
    sessionExpiresAt?: number;
  }
}
