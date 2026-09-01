import test from 'node:test'
import assert from 'node:assert/strict'
import { makeXlsx, makeDocx, makePdf } from '../src/services/office-generators.mjs'

test('binary generators produce real xlsx/docx/pdf containers', () => {
  const xlsx = makeXlsx([['姓名', '年龄'], ['张三', 30]])
  const docx = makeDocx({ title: '报告', paragraphs: ['第一段'] })
  const pdf = makePdf({ title: '报告', text: '第一段' })
  assert.equal(xlsx.subarray(0, 4).toString('hex'), '504b0304')
  assert.equal(docx.subarray(0, 4).toString('hex'), '504b0304')
  assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4')
  assert.ok(xlsx.length > 500)
  assert.ok(docx.length > 300)
  assert.ok(pdf.length > 100)
})
