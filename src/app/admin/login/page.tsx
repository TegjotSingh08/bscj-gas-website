import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { currentSession } from "@/lib/auth/session";
import { business } from "@/lib/business";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false, follow: false, nocache: true },
};

/** Force-dynamic: this page's answer depends on the caller's session. */
export const dynamic = "force-dynamic";

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  // Already signed in? There is nothing to do here.
  if (await currentSession()) redirect("/admin");

  const { next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-12">
      <div className="rounded-2xl border-2 border-navy-200 bg-white p-6 shadow-sm sm:p-8">
        <p className="text-lg font-extrabold text-navy-900">
          BSCJ <span className="text-flame-600">Gas &amp; Heating</span>
        </p>
        <h1 className="mt-4 text-2xl font-extrabold text-navy-900">
          Staff sign in
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-navy-600">
          This area is for {business.name} staff. If you are a customer looking
          for your booking, the details are in your confirmation email.
        </p>

        <LoginForm next={next} />
      </div>
    </main>
  );
}
