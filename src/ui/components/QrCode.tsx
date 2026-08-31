import { useMemo } from "react";
import { encodeQrCode } from "@/core/qr/qrCode";

/**
 * QR code, rendered as inline SVG.
 *
 * SVG rather than a canvas so it stays crisp at any size and needs no ref, no
 * effect and no device-pixel-ratio handling -- a canvas QR at the wrong DPR is
 * a blurry QR, and a blurry QR is one a phone camera gives up on.
 *
 * The quiet zone is not decoration. The specification requires four modules of
 * light margin, and scanners genuinely fail without it: a code flush against a
 * dark background has no edge for the locator to find.
 *
 * Colours are hardcoded black-on-white rather than themed. A QR is read by a
 * camera, not by the user, and a dark-theme QR in muted greys is one many
 * scanners will not resolve. The surrounding card carries the theme; the code
 * itself stays maximally legible to a machine.
 */

export const QR_QUIET_ZONE_MODULES = 4;

export function QrCode({
  value,
  size = 180,
  label,
}: {
  value: string;
  size?: number;
  label?: string | undefined;
}) {
  const code = useMemo(() => {
    try {
      return encodeQrCode(value);
    } catch {
      // Too long to encode. The receive screen always shows the address as text
      // as well, so losing the picture degrades rather than breaks -- and a
      // truncated QR would be far worse, because it would still scan.
      return undefined;
    }
  }, [value]);

  if (!code) return null;

  const totalModules = code.size + QR_QUIET_ZONE_MODULES * 2;
  const paths: string[] = [];
  for (let row = 0; row < code.size; row += 1) {
    for (let column = 0; column < code.size; column += 1) {
      if (!(code.modules[row] as boolean[])[column]) continue;
      // One rect per dark module, emitted as a single path. Rounding is
      // deliberately absent: rounded modules look nicer and scan worse.
      paths.push(
        `M${column + QR_QUIET_ZONE_MODULES} ${row + QR_QUIET_ZONE_MODULES}h1v1h-1z`,
      );
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${totalModules} ${totalModules}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label ?? "QR code"}
      className="rounded-(--radius-card)"
    >
      <rect width={totalModules} height={totalModules} fill="#FFFFFF" />
      <path d={paths.join("")} fill="#000000" />
    </svg>
  );
}
