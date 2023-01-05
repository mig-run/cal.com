import { LOGO_ICON, LOGO } from "@calcom/lib/constants";

export default function Logo({ small, icon }: { small?: boolean; icon?: boolean }) {
  return (
    <h1 className="logo inline">
      <strong>
        {icon ? (
          <img className="mx-auto w-9" alt="MigRun Booking" title="MigRun Booking" src={LOGO_ICON} />
        ) : (
          <img
            className={small ? "h-10 w-auto" : "h-10 w-auto"}
            alt="MigRun Booking"
            title="MigRun Booking"
            src={LOGO}
          />
        )}
      </strong>
    </h1>
  );
}
