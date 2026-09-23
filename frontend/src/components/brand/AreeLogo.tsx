/*
   AREE brand mark — the single source of truth for the logo.

   The artwork is the supplied brand PNG, used as-is — deliberately not redrawn
   as vectors. /aree-mark.png is that file with its transparent margin trimmed
   off and a small uniform one added back; untrimmed, the art occupied about a
   third of the frame and rendered ~18px wide in a 50px sidebar slot.

   src/app/icon.png (the favicon) is the same art padded to a transparent
   square, so a replacement mark means regenerating that too. Every consumer
   should import from here rather than hard-coding an <img> to those paths.
*/

import Image from "next/image";

/** aree-mark.png is 1040 × 706. */
const MARK_RATIO = 706 / 1040;

interface AreeMarkProps {
  /** Rendered width in px; height follows the PNG's own ratio. */
  size?: number;
  className?: string;
}

/** The glyph alone — sidebar tile, avatar slot. */
export function AreeMark({ size = 50, className }: AreeMarkProps) {
  return (
    <Image
      src="/aree-mark.png"
      alt="AREE"
      width={size}
      height={Math.round(size * MARK_RATIO)}
      className={className}
      priority
    />
  );
}

interface AreeLogoProps extends AreeMarkProps {
  /** Hide the "AREE / ENVIRONMENTAL INTELLIGENCE" text — collapsed rails. */
  wordmark?: boolean;
  /** Drop the tagline line but keep "AREE". */
  tagline?: boolean;
}

/**
 * Mark plus text, for horizontal chrome such as the sidebar header. The supplied
 * artwork is the mark only, so the wordmark is set in HTML — which also lets it
 * hide when the rail collapses and inherit the theme's own colours.
 */
export function AreeLogo({
  size = 34,
  className,
  wordmark = true,
  tagline = true,
}: AreeLogoProps) {
  return (
    <span className={`flex items-center gap-2.5 ${className ?? ""}`}>
      <AreeMark size={size} className="shrink-0" />
      {wordmark && (
        <span className="flex min-w-0 flex-col">
          <span className="text-aree-text text-base leading-tight font-black tracking-[0.14em]">
            AREE
          </span>
          {tagline && (
            <span className="text-aree-dim truncate text-[8px] font-semibold tracking-[0.04em] uppercase">
              Environmental Intelligence
            </span>
          )}
        </span>
      )}
    </span>
  );
}

export default AreeLogo;
