import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

import {
  authenticateUser,
  recordLogin,
  type UserIdentity,
} from "@/lib/auth/app-user";
import { isAppRole } from "@/lib/auth/roles";

/**
 * Authentication, for everyone who signs in: BSCJ staff and agency users.
 *
 * Auth.js rather than a hand-rolled cookie, because the parts that are easy to
 * get subtly wrong — session signing and rotation, CSRF on the sign-in POST,
 * cookie flags, the callback surface — are exactly the parts it does properly.
 * The credential check itself stays ours, in `lib/auth/app-user.ts`.
 *
 * A Credentials provider with a JWT session, not a database session: a handful
 * of internal users and a small number of agency users do not need a session
 * table, and a stateless session avoids a round trip to look one up.
 *
 * **The token identifies the user and nothing more.** The role and the
 * organisation are carried on it as a convenience for rendering, and are
 * re-read from the database on every request that makes a decision — see
 * `lib/auth/session.ts`. A signed token is not a fresh one: it cannot know
 * that an account was deactivated or moved since it was issued.
 *
 * Nothing about this reaches the public site. No public page imports from here.
 */

/** Eight hours: a working day, then sign in again. */
const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/admin/login" },

  providers: [
    Credentials({
      name: "BSCJ",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email;
        const password = credentials?.password;
        if (typeof email !== "string" || typeof password !== "string") {
          return null;
        }

        const identity = await authenticateUser(email, password);
        if (!identity) return null;

        await recordLogin(identity.id);
        return identity;
      },
    }),
  ],

  callbacks: {
    jwt({ token, user }) {
      if (user) {
        const identity = user as unknown as UserIdentity;
        token.sub = identity.id;
        token.role = identity.role;
        token.organisationId = identity.agentOrganisationId ?? null;
        /*
          The account's session version at the moment of sign-in.

          The one value on this token that is actually compared against the
          database rather than re-read past — and only in the refusing
          direction: `lib/auth/session.ts` refuses a token whose version is
          behind the column. It can end a session; it can never create one.
          That is what makes a password reset take effect on the next request
          instead of in eight hours.
        */
        token.sessionVersion = identity.sessionVersion;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = typeof token.sub === "string" ? token.sub : "";
        /*
          Defaulted rather than trusted. These two fields exist so a layout can
          render the right navigation without a query; nothing that grants
          access reads them, because a value on a token is eight hours stale by
          design. `lib/auth/session.ts` re-reads both from the database.
        */
        session.user.role = isAppRole(token.role) ? token.role : "admin";
        session.user.organisationId =
          typeof token.organisationId === "string" ? token.organisationId : null;
        /*
          Defaulted to 0, which is the column's default. A token issued before
          this field existed therefore reads as version 0 and keeps working
          against an account nobody has reset — rather than every existing
          session being invalidated by a deploy.
        */
        session.user.sessionVersion =
          typeof token.sessionVersion === "number" ? token.sessionVersion : 0;
      }
      return session;
    },
  },
});
