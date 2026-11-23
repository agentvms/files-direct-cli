import qrcode from 'qrcode-generator';

/** A QR code for the terminal: black on white, two rows of modules to a line, four modules of quiet space around it. */
export function terminalQr(text: string): string {
  const q = qrcode(0, 'L');
  q.addData(text, 'Byte');
  q.make();
  const n = q.getModuleCount();
  const quiet = 2;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c);
  const lines: string[] = [];
  for (let r = -quiet; r < n + quiet; r += 2) {
    let line = '\x1b[30;47m';
    for (let c = -quiet; c < n + quiet; c++) {
      const top = dark(r, c);
      const bottom = dark(r + 1, c);
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(line + '\x1b[0m');
  }
  return lines.join('\n');
}
