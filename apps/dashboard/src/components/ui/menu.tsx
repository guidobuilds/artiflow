import {
  cloneElement,
  createContext,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type MouseEventHandler,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils.ts";
import { Icon, type IconName } from "@/components/ui/icon.tsx";

type MenuContextValue = { close: () => void };

const MenuContext = createContext<MenuContextValue | null>(null);

type MenuTriggerProps = {
  onClick?: MouseEventHandler<HTMLElement>;
  "aria-haspopup"?: string;
  "aria-expanded"?: boolean;
};

export function Menu({
  trigger,
  align = "start",
  width,
  label,
  className,
  wrapClassName,
  children,
}: {
  trigger: ReactElement<MenuTriggerProps>;
  align?: "start" | "end";
  width?: number;
  label?: string;
  className?: string;
  wrapClassName?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (wrapRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const wrap = wrapRef.current;
    const surface = surfaceRef.current;
    if (!wrap || !surface) return;
    const rect = wrap.getBoundingClientRect();
    const needsFlip =
      window.innerHeight - rect.bottom < surface.offsetHeight + 8 && rect.top > surface.offsetHeight + 8;
    setFlipped(needsFlip);
    const first = surface.querySelector<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])");
    first?.focus({ preventScroll: true });
  }, [open]);

  const cycleFocus = (direction: 1 | -1) => {
    const items = Array.from(
      surfaceRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])") ?? [],
    );
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next = items[(current + direction + items.length) % items.length];
    next?.focus({ preventScroll: true });
  };

  const returnFocusToTrigger = () => {
    wrapRef.current
      ?.querySelector<HTMLElement>("button, a, [role='button'], [tabindex]")
      ?.focus({ preventScroll: true });
  };

  let triggerElement: ReactNode = trigger;
  if (isValidElement<MenuTriggerProps>(trigger)) {
    const original = trigger.props.onClick;
    triggerElement = cloneElement(trigger, {
      onClick: (event) => {
        original?.(event);
        setOpen((current) => !current);
      },
      "aria-haspopup": "menu",
      "aria-expanded": open,
    });
  }

  return (
    <span
      ref={wrapRef}
      className={cn("relative inline-flex", wrapClassName)}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          returnFocusToTrigger();
          return;
        }
        if (!open) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          cycleFocus(1);
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          cycleFocus(-1);
        }
      }}
    >
      {triggerElement}
      {open ? (
        <div
          ref={surfaceRef}
          role="menu"
          aria-label={label}
          style={width ? { minWidth: width } : undefined}
          className={cn(
            "absolute top-full z-50 mt-1 min-w-[200px] max-w-[calc(100vw-32px)] overflow-hidden rounded-md border border-line-strong bg-bg-raised shadow-floating animate-pop-in",
            "[&>*+*]:border-t [&>*+*]:border-line",
            align === "end" ? "right-0" : "left-0",
            flipped && "top-auto bottom-full mt-0 mb-1",
            className,
          )}
        >
          <MenuContext.Provider value={{ close }}>{children}</MenuContext.Provider>
        </div>
      ) : null}
    </span>
  );
}

export function MenuHead({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("bg-surface px-3 py-2 text-fg-subtle caps", className)} {...props} />;
}

export function MenuSeparator({ className, ...props }: ComponentProps<"div">) {
  return <div role="separator" className={cn("border-t border-line-strong", className)} {...props} />;
}

export function MenuItem({
  icon,
  meta,
  checked,
  danger,
  disabled,
  className,
  onClick,
  children,
  ...props
}: ComponentProps<"button"> & {
  icon?: IconName;
  meta?: ReactNode;
  checked?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const menu = useContext(MenuContext);
  return (
    <button
      type="button"
      role="menuitem"
      aria-disabled={disabled || undefined}
      aria-checked={checked === undefined ? undefined : checked}
      className={cn(
        "flex min-h-9 w-full cursor-pointer items-center gap-2.5 px-3 text-left text-[13.5px] transition-colors duration-120",
        disabled
          ? "text-fg-subtle"
          : cn(
              "hover:bg-hover focus-visible:bg-hover focus-visible:outline-none",
              danger ? "text-danger-text" : "text-fg",
            ),
        className,
      )}
      onClick={(event) => {
        if (disabled) return;
        menu?.close();
        onClick?.(event);
      }}
      {...props}
    >
      {icon ? <Icon name={icon} className={cn("size-4", danger ? "" : "text-fg-muted")} /> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {meta ? <span className="pl-4 font-mono text-[11px] text-fg-subtle">{meta}</span> : null}
      {checked ? <Icon name="check" className={cn("text-accent-text", meta ? "ml-2" : "ml-auto", "size-3.5")} /> : null}
    </button>
  );
}
