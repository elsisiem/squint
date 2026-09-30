import qrcode from "qrcode-generator";

/** QR code as a self-contained SVG (works in <img>). Horizontal runs are merged into one path. */
export function qrSvg(text: string, scale = 8): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m = 4; // quiet zone
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let w = 1;
      while (c + w < n && qr.isDark(r, c + w)) w++;
      d += `M${c + m} ${r + m}h${w}v1h-${w}z`;
      c += w;
    }
  }
  const size = n + m * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * scale}" height="${size * scale}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#0b1020" d="${d}"/></svg>`
  );
}
