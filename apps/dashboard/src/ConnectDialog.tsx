import { useEffect, useId, useRef, useState } from "react";

import { AgentLogo, type AgentMarkName } from "@/components/ui/agent-logo.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog, DialogContent, DialogHead, DialogTitle } from "@/components/ui/dialog.tsx";
import { Icon } from "@/components/ui/icon.tsx";
import { useToast } from "@/components/ui/toast.tsx";
import { cn } from "@/lib/utils.ts";

const OPEN_EVENT = "artiflow:connect";

export function openConnect(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

export function onOpenConnect(listener: () => void): () => void {
  window.addEventListener(OPEN_EVENT, listener);
  return () => window.removeEventListener(OPEN_EVENT, listener);
}

export function mcpUrl(): string {
  return `${window.location.origin}/mcp`;
}

export function setupPrompt(): string {
  return `Connect artiflow for me. Add the MCP server at ${mcpUrl()}, open the sign-in page when it asks, then publish a short page called “Hello from my agent”.`;
}

const TRY_PROMPT = "Publish a page called “Hello” on artiflow with one paragraph about what this server is for.";

type Client = {
  name: string;
  mark?: AgentMarkName;
  letters?: string;
  lead: string;
  where: string;
  code: (url: string) => string;
  after?: { text: string; code: string };
  signIn: string;
};

const CLIENTS: Client[] = [
  {
    name: "Claude Code",
    mark: "claude",
    lead: "One command in your terminal.",
    where: "Terminal",
    code: (url) => `claude mcp add --transport http artiflow ${url}`,
    signIn: "Run /mcp inside Claude Code and follow the sign-in prompt.",
  },
  {
    name: "Codex",
    mark: "codex",
    lead: "Add the server to your Codex config, then sign in once.",
    where: "~/.codex/config.toml",
    code: (url) => `[mcp_servers.artiflow]\nurl = "${url}"`,
    after: { text: "Then sign in once from your terminal:", code: "codex mcp login artiflow" },
    signIn: "The login command opens this browser to approve access.",
  },
  {
    name: "OpenCode",
    mark: "opencode",
    lead: "Add a remote server to opencode.json.",
    where: "opencode.json",
    code: (url) => `{\n  "mcp": {\n    "artiflow": { "type": "remote", "url": "${url}" }\n  }\n}`,
    signIn: "OpenCode opens this browser the first time a tool needs access.",
  },
  {
    name: "Cursor",
    mark: "cursor",
    lead: "Add the server to your Cursor config.",
    where: "~/.cursor/mcp.json",
    code: (url) => `{\n  "mcpServers": {\n    "artiflow": { "url": "${url}" }\n  }\n}`,
    signIn: "Cursor opens this browser the first time a tool needs access.",
  },
  {
    name: "Other client",
    letters: "···",
    lead: "Any MCP client with Streamable HTTP and OAuth.",
    where: "Settings",
    code: (url) => `Server URL   ${url}\nAuth         OAuth 2.1, approved in this browser`,
    signIn: "The client opens this browser the first time it needs access.",
  },
];

const STEPS = ["Add server", "Approve", "Try it"] as const;

export default function ConnectDialog({
  open,
  onClose,
  artifactCount,
}: {
  open: boolean;
  onClose: () => void;
  artifactCount?: number;
}) {
  const [clientIndex, setClientIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [baseline, setBaseline] = useState<number | null>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const id = useId();
  const { toast } = useToast();
  const client = CLIENTS[clientIndex]!;
  const url = mcpUrl();
  const code = client.code(url);
  const arrived = baseline !== null && artifactCount !== undefined && artifactCount > baseline;

  useEffect(() => {
    if (!open) {
      setStep(0);
      setBaseline(null);
    }
  }, [open]);
  useEffect(() => {
    if (step === 2 && baseline === null && artifactCount !== undefined) setBaseline(artifactCount);
  }, [step, baseline, artifactCount]);

  const copy = async (value: string, message = "Copied") => {
    try {
      await navigator.clipboard.writeText(value);
      toast(message);
    } catch {
      toast("Couldn't copy. Select the text and copy it manually.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        aria-describedby={`${id}-lead`}
        className="top-[9dvh] h-[min(620px,82dvh)] max-w-[860px] flex-row max-sm:h-[88dvh] max-sm:flex-col"
      >
        <div className="flex w-[232px] flex-none flex-col gap-3.5 border-r border-line bg-[var(--side-bg)] px-3 py-5 max-sm:w-full max-sm:gap-2 max-sm:border-r-0 max-sm:border-b max-sm:py-3.5">
          <div className="grid gap-0.5 px-2">
            <DialogTitle className="p-0 text-[16px] font-semibold tracking-[-0.02em]">Connect an agent</DialogTitle>
            <span className="text-[12.5px] text-fg-subtle max-sm:hidden">Pick where it runs</span>
          </div>
          <div
            role="tablist"
            aria-label="Agent"
            aria-orientation="vertical"
            className="flex flex-col gap-0.5 max-sm:flex-row max-sm:overflow-x-auto"
          >
            {CLIENTS.map((option, index) => (
              <button
                key={option.name}
                ref={(node) => {
                  tabs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`${id}-tab-${index}`}
                aria-selected={clientIndex === index}
                aria-controls={`${id}-panel`}
                tabIndex={clientIndex === index ? 0 : -1}
                className={cn(
                  "flex h-[42px] flex-none cursor-pointer items-center gap-2.5 rounded-[10px] px-2 text-left text-[13.5px] text-fg transition-colors duration-120",
                  clientIndex === index ? "bg-hover font-medium" : "hover:bg-hover",
                )}
                onClick={() => {
                  setClientIndex(index);
                  setStep(0);
                }}
                onKeyDown={(event) => {
                  const last = CLIENTS.length - 1;
                  let next: number;
                  if (event.key === "ArrowDown" || event.key === "ArrowRight") next = index === last ? 0 : index + 1;
                  else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = index === 0 ? last : index - 1;
                  else if (event.key === "Home") next = 0;
                  else if (event.key === "End") next = last;
                  else return;
                  event.preventDefault();
                  setClientIndex(next);
                  setStep(0);
                  tabs.current[next]?.focus();
                }}
              >
                <AgentLogo mark={option.mark} letters={option.letters} />
                <span className="pr-1">{option.name}</span>
              </button>
            ))}
          </div>
          <span className="mt-auto px-2 text-[12px] text-fg-subtle max-sm:hidden">
            Any client that speaks MCP over HTTP works.
          </span>
        </div>

        <div
          id={`${id}-panel`}
          role="tabpanel"
          aria-labelledby={`${id}-tab-${clientIndex}`}
          className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <DialogHead />
          <ol aria-label="Steps" className="flex items-center gap-2.5 px-6 pt-[18px] pr-14 max-sm:px-4 max-sm:pr-12">
            {STEPS.map((label, index) => (
              <li
                key={label}
                aria-current={index === step ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2 text-[13px] whitespace-nowrap",
                  index === step ? "font-medium text-fg" : "text-fg-subtle",
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "grid size-[22px] place-items-center rounded-full border font-mono text-[11.5px]",
                    index === step ? "border-fg bg-fg text-bg" : index < step ? "border-fg text-fg" : "border-line",
                  )}
                >
                  {index < step ? <Icon name="check" className="size-3" /> : index + 1}
                </span>
                <span className={index === step ? undefined : "max-sm:sr-only"}>{label}</span>
                {index < STEPS.length - 1 ? <span aria-hidden="true" className="h-px w-5 bg-line" /> : null}
              </li>
            ))}
          </ol>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-8 pt-7 pb-6 max-sm:px-4 max-sm:pt-5">
            {step === 0 ? (
              <>
                <div className="grid gap-1.5">
                  <h3 className="text-[22px] font-semibold tracking-[-0.03em]">Add artiflow to {client.name}</h3>
                  <p id={`${id}-lead`} className="text-fg-muted">
                    {client.lead}
                  </p>
                </div>
                <div className="overflow-hidden rounded-[10px] border border-line">
                  <div className="flex items-center justify-between gap-3 border-b border-line bg-surface py-2 pr-2 pl-3">
                    <span className="truncate font-mono text-[12px] text-fg-subtle">{client.where}</span>
                    <Button size="sm" variant="primary" onClick={() => void copy(code)}>
                      Copy
                    </Button>
                  </div>
                  <pre className="m-0 overflow-x-auto px-4 py-3.5 font-mono text-[12.5px] leading-[1.65] text-fg select-text">
                    {code}
                  </pre>
                </div>
                {client.after ? (
                  <p className="text-fg-muted">
                    {client.after.text}{" "}
                    <code className="rounded-xs bg-surface px-1.5 py-px font-mono text-[12.5px] text-fg">
                      {client.after.code}
                    </code>
                  </p>
                ) : null}
              </>
            ) : null}

            {step === 1 ? (
              <>
                <div className="grid gap-1.5">
                  <h3 className="text-[22px] font-semibold tracking-[-0.03em]">Sign in and approve</h3>
                  <p id={`${id}-lead`} className="text-fg-muted">
                    {client.name} opens this browser the first time it needs artiflow. Nothing is shared until you
                    choose.
                  </p>
                </div>
                <figure className="m-0 grid gap-3 rounded-lg border border-line bg-bg p-[18px]">
                  <figcaption className="sr-only">What the approval screen looks like</figcaption>
                  <b className="font-semibold tracking-[-0.02em]">{client.name} wants to use your artiflow account</b>
                  <span className="text-[13.5px] text-fg-muted">
                    It will be able to read and create the artifacts you own. You can deny it.
                  </span>
                  <div aria-hidden="true" className="flex gap-2">
                    <span className="inline-flex h-[34px] items-center rounded-md border border-line-strong px-3.5 font-medium">
                      Deny
                    </span>
                    <span className="inline-flex h-[34px] items-center rounded-md bg-fg px-3.5 font-medium text-bg">
                      Approve
                    </span>
                  </div>
                </figure>
                <p className="text-fg-muted">{client.signIn}</p>
              </>
            ) : null}

            {step === 2 ? (
              <>
                <div className="grid gap-1.5">
                  <h3 className="text-[22px] font-semibold tracking-[-0.03em]">Ask for something</h3>
                  <p id={`${id}-lead`} className="text-fg-muted">
                    Paste this to {client.name}. The result shows up in your library.
                  </p>
                </div>
                <div className="grid gap-3 rounded-[10px] border border-line px-4 py-3.5">
                  <span className="font-mono text-[12.5px] leading-[1.6] text-fg select-text">{TRY_PROMPT}</span>
                  <Button size="sm" className="justify-self-start" onClick={() => void copy(TRY_PROMPT)}>
                    <Icon name="copy" className="size-[13px]" />
                    Copy prompt
                  </Button>
                </div>
                {artifactCount !== undefined ? (
                  <p role="status" className="flex items-center gap-2.5 text-[13.5px] text-fg-muted">
                    {arrived ? (
                      <>
                        <Icon name="check" className="size-4 text-accent-text" />
                        It arrived. You'll find it in your library.
                      </>
                    ) : (
                      <>
                        <span aria-hidden="true" className="size-2 rounded-full bg-accent" />
                        Waiting for the first artifact. This page updates when it arrives.
                      </>
                    )}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-2.5 border-t border-line px-6 py-4 max-sm:px-4">
            <Button className={step === 0 ? "invisible" : undefined} onClick={() => setStep(step - 1)}>
              Back
            </Button>
            <Button variant="primary" onClick={() => (step === STEPS.length - 1 ? onClose() : setStep(step + 1))}>
              {step === STEPS.length - 1 ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
