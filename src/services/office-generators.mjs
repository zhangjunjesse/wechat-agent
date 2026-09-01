import zlib from 'node:zlib'

export function makeXlsx(rows) {
  const data = Array.isArray(rows) ? rows : []
  const shared = []
  const sharedIndex = new Map()
  const s = (v) => {
    const x = String(v ?? '')
    if (!sharedIndex.has(x)) { sharedIndex.set(x, shared.length); shared.push(x) }
    return sharedIndex.get(x)
  }
  const sheetRows = data.map((row, ri) => `<row r="${ri + 1}">${(Array.isArray(row) ? row : Object.values(row || {})).map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="s"><v>${s(v)}</v></c>`).join('')}</row>`).join('')
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
    '_rels/.rels': rels('rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'xl/workbook.xml'),
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': relationships([['rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet', 'worksheets/sheet1.xml'], ['rId2', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings', 'sharedStrings.xml']]),
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map(x => `<si><t>${xml(x)}</t></si>`).join('')}</sst>`,
  }
  return zip(files)
}

export function makeDocx({ title = '文档', paragraphs = [] } = {}) {
  const body = [`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${xml(title)}</w:t></w:r></w:p>`, ...paragraphs.map(p => `<w:p><w:r><w:t xml:space="preserve">${xml(p)}</w:t></w:r></w:p>`)].join('')
  return zip({
    '[Content_Types].xml': `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': rels('rId1', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'word/document.xml'),
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  })
}

export function makePdf({ title = '文档', text = '' } = {}) {
  const lines = [title, ...String(text).split(/\r?\n/)].slice(0, 80)
  const stream = `BT /F1 12 Tf 50 780 Td ${lines.map((line, i) => `(${pdfText(line)}) Tj ${i < lines.length - 1 ? '0 -18 Td' : ''}`).join(' ')} ET`
  const objects = [`<< /Type /Catalog /Pages 2 0 R >>`, `<< /Type /Pages /Kids [3 0 R] /Count 1 >>`, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`]
  let out = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((obj, i) => { offsets[i + 1] = Buffer.byteLength(out); out += `${i + 1} 0 obj\n${obj}\nendobj\n` })
  const xref = Buffer.byteLength(out); out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10, '0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}

function relationships(items) { return `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')}</Relationships>` }
function rels(id, type, target) { return relationships([[id, type, target]]) }
function xml(v) { return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }
function pdfText(v) { return String(v).replace(/([\\()])/g, '\\$1').replace(/[^\x20-\x7e]/g, '?') }
function col(n) { let x = ''; do { x = String.fromCharCode(65 + (n % 26)) + x; n = Math.floor(n / 26) - 1 } while (n >= 0); return x }
function crc32(buf) { let c = 0xffffffff; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)) } return (c ^ 0xffffffff) >>> 0 }
function zip(files) {
  const locals = []; const central = []; let offset = 0
  for (const [name, value] of Object.entries(files)) { const data = Buffer.from(value); const nb = Buffer.from(name); const crc = crc32(data); const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt32LE(0, 8); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28); locals.push(Buffer.concat([h, nb, data])); const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(offset, 42); central.push(Buffer.concat([c, nb])); offset += locals.at(-1).length }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(8, 8); e.writeUInt16LE(8, 10); e.writeUInt16LE(central.length ? Object.keys(files).length : 0, 12); e.writeUInt16LE(Object.keys(files).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16); return Buffer.concat([...locals, cd, e])
}
