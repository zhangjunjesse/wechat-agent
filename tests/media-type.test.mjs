import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyMediaType } from '../src/services/media-type.mjs'

test('classifyMediaType maps video extensions to video', () => {
  for (const name of ['clip.mp4', 'MOV.mov', 'a.avi', 'b.mkv', 'c.webm', 'd.flv', 'e.wmv', 'f.m4v', 'g.ts', 'h.3gp', 'i.mpeg', 'j.mpg', 'k.rmvb']) {
    assert.equal(classifyMediaType(name), 'video', name)
  }
})

test('classifyMediaType maps image extensions to image', () => {
  for (const name of ['photo.jpg', 'PNG.png', 'a.gif', 'b.webp', 'c.bmp', 'd.heic', 'e.heif', 'f.ico', 'g.tif', 'h.tiff', 'i.avif', 'j.jpeg']) {
    assert.equal(classifyMediaType(name), 'image', name)
  }
})

test('classifyMediaType defaults everything else to file', () => {
  for (const name of ['report.csv', 'a.docx', 'b.xlsx', 'c.pdf', 'd.zip', 'e.txt', 'noext', 'voice.mp3', 'x.tar.gz', '中文名.md']) {
    assert.equal(classifyMediaType(name), 'file', name)
  }
})

test('classifyMediaType handles full paths and ignores the directory part', () => {
  assert.equal(classifyMediaType('out/clips/生日视频.mp4'), 'video')
  assert.equal(classifyMediaType('C:\\Users\\a\\Pictures\\pic.JPG'), 'image')
  assert.equal(classifyMediaType('data/notes.md'), 'file')
})
