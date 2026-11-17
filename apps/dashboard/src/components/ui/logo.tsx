import { cn } from "@/lib/utils.ts";

export function Logo({
  withWordmark = true,
  className,
  ...props
}: { withWordmark?: boolean } & React.ComponentProps<"span">) {
  return (
    <span className={cn("inline-flex items-center", className)} {...props}>
      {withWordmark ? (
        <svg
          viewBox="-1.3 -0.3 101.6 21.6"
          width="104"
          height="22"
          aria-hidden="true"
          className="shrink-0 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.6]"
        >
          <path d="M0 15 A5 5 0 0 1 10 15 A5 5 0 0 1 0 15 M10 10 V17 A3 3 0 0 0 13 20" />
          <path transform="translate(14.5 0)" d="M-2 20 A2 2 0 0 0 0 18 V15 A5 5 0 0 1 5 10" />
          <path transform="translate(23.5 0)" d="M3 3 V15 A5 5 0 0 0 8 20 H10.5 A3 3 0 0 0 13.5 17 V10 M0 10 H7" />
          <path transform="translate(40.5 0)" d="M3 20 V7 A4 4 0 0 1 7 3 H8 M0 10 H7" />
          <path transform="translate(53 0)" d="M0 2 V16 A4 4 0 0 0 4 20" />
          <path transform="translate(60.5 0)" d="M0 15 A5 5 0 0 1 10 15 A5 5 0 0 1 0 15" />
          <path transform="translate(75 0)" d="M0 10 V15 A4 4 0 0 0 8 15 A4 4 0 0 1 16 15 A4 4 0 0 0 24 15 V10" />
          <circle cx="37" cy="5.2" r="1.2" className="fill-accent stroke-none" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          aria-hidden="true"
          className="shrink-0 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:2.4]"
        >
          <path d="M3.5 19.5V12a5.5 5.5 0 0 1 11 0v7.5M17 6.5h4M14.5 13h5" />
          <circle cx="9" cy="15.5" r="2" className="fill-accent stroke-none" />
        </svg>
      )}
      <span className="sr-only">artiflow</span>
    </span>
  );
}
