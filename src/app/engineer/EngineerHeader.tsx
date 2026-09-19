import Link from "next/link";

import { SignOutButton } from "../admin/SignOutButton";

/**
 * The header on every engineer screen.
 *
 * One link, back to the day. There is no navigation to build here: an
 * engineer has a day and the job in front of them, and a menu of anything
 * else on a phone screen in a doorway is a menu of wrong taps.
 *
 * `back` is the job screen's way home. On the day itself it is omitted, so
 * the title is not also a link to where you already are.
 */
export function EngineerHeader({
  userName,
  back,
}: {
  userName: string;
  back?: boolean;
}) {
  return (
    <header className="border-b-2 border-navy-200 bg-white">
      <div className="mx-auto flex max-w-2xl items-center justify-between gap-3 px-4 py-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-flame-600">
            BSCJ Gas &amp; Heating
          </p>
          {back ? (
            <Link
              href="/engineer"
              className="text-lg font-extrabold text-navy-900 underline"
            >
              ← Today
            </Link>
          ) : (
            <p className="text-lg font-extrabold text-navy-900">{userName}</p>
          )}
        </div>
        <SignOutButton />
      </div>
    </header>
  );
}
