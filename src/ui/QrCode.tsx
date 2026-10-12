import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** A QR code as crisp SVG (one path), readable by any phone camera. */
export function QrCode({ text, label, size = 220 }: { text: string; label: string; size?: number }) {
  const { count, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { count: n + 8, path: d }; // 4 modules of quiet zone around it
  }, [text]);
  return (
    <svg className="qr" role="img" aria-label={label} viewBox={`0 0 ${count} ${count}`} width={size} height={size} shapeRendering="crispEdges">
      <rect width={count} height={count} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
