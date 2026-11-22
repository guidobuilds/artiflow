import { providerMark } from "@/provider-marks.ts";
import { cn } from "@/lib/utils.ts";

const SIZE = "size-4 shrink-0";

export function ProviderMark({ provider }: { provider: string }) {
  const mark = providerMark(provider);
  if (mark === null) return null;
  if (mark.monochrome) {
    return (
      <span
        aria-hidden="true"
        className={cn("inline-block bg-current", SIZE)}
        style={{
          maskImage: `url("${mark.src}")`,
          maskPosition: "center",
          maskRepeat: "no-repeat",
          maskSize: "contain",
        }}
      />
    );
  }
  return <img src={mark.src} alt="" aria-hidden="true" draggable={false} className={cn("object-contain", SIZE)} />;
}
