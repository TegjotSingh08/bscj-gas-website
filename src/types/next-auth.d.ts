import type { DefaultSession } from "next-auth";
import type { AppRole } from "@/lib/auth/roles";

/**
 * The fields this application adds to a session: who the user is, what they
 * are, and which organisation they belong to.
 *
 * Declared so a layout reads them type-safely rather than casting at each use.
 * **None of them grants access** — they are for rendering. Anything that makes
 * a decision re-reads the user from the database; see `lib/auth/session.ts`.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: AppRole;
      /** Null for BSCJ staff. */
      organisationId: string | null;
      /**
       * The account's session version at the moment this token was issued.
       *
       * The one field on the token that **is** load-bearing, and it is
       * load-bearing in the refusing direction only: `currentSession` compares
       * it with the column and refuses a mismatch. It can make a session stop
       * working; it can never make one work.
       */
      sessionVersion: number;
    } & DefaultSession["user"];
  }

  interface User {
    role?: AppRole;
    agentOrganisationId?: string | null;
    sessionVersion?: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    role?: AppRole;
    organisationId?: string | null;
    sessionVersion?: number;
  }
}
