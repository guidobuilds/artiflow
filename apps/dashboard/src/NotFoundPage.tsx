import { BareShell } from "@/components/app/app-shell.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Terminal, TerminalOutput, TerminalTool } from "@/components/ui/terminal.tsx";

export default function NotFoundPage() {
  const requestedPath = window.location.pathname;

  return (
    <BareShell>
      <div className="grid flex-1 place-items-center px-4 py-10">
        <section
          aria-labelledby="not-found-heading"
          className="grid w-full max-w-[620px] min-w-0 justify-items-start gap-3.5"
        >
          <p className="font-mono text-[13px] text-fg-subtle">404 · Not found</p>
          <h1 id="not-found-heading" className="display text-[clamp(32px,5vw,52px)]">
            This page isn&rsquo;t here.
            <span aria-hidden="true" className="caret" />
          </h1>
          <p className="max-w-[52ch] text-[16px] text-fg-muted">Check the URL, or go back to your library.</p>
          <Terminal className="my-2.5 w-full border-line bg-bg-raised">
            <TerminalTool>GET {requestedPath}</TerminalTool>
            <TerminalOutput className="text-danger-text">404 · Nothing at this address</TerminalOutput>
          </Terminal>
          <a href="/" className={buttonVariants({ variant: "primary", className: "no-underline hover:opacity-90" })}>
            Back to your library
          </a>
        </section>
      </div>
    </BareShell>
  );
}
