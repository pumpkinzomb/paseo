export function createPdfFixture(count = 3) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.alert('must-not-run')) >> >>",
    `<< /Type /Pages /Kids [${Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(" ")}] /Count ${count} >>`,
  ];
  for (let page = 1; page <= count; page++)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page === 2 ? "842 595" : "595 842"}] /Resources << /Font << /F1 ${count + 3} 0 R >> >> /Contents ${count + 3 + page} 0 R >>`,
    );
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  for (let page = 1; page <= count; page++) {
    const top = page === 2 ? 450 : 700;
    const text = `0.15 0.35 0.65 rg 40 ${top - 70} 515 150 re f BT /F1 26 Tf 1 1 1 rg 65 ${top} Td (PDF Preview Page ${page}) Tj ET BT /F1 16 Tf 0 0 0 rg 65 ${top - 140} Td (Readable original file, not a text reconstruction.) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
  }
  let pdf = "%PDF-1.7\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf).toString("base64");
}
