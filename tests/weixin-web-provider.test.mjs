import test from 'node:test'
import assert from 'node:assert/strict'
import { WeixinWebProvider } from '../src/providers/weixin-web-provider.mjs'

test('provider maps UUID, QR, scan, login init and profile fields', async () => {
  const calls = []
  let n = 0
  const responses = [
    { text: async () => 'window.QRLogin.code = 200; window.QRLogin.uuid = "u-1"' },
    { text: async () => 'window.code=201;' },
    { text: async () => 'window.code=200; window.redirect_uri="https://wx.example/cgi-bin/mmwebwx-bin/webwxnewloginpage?ticket=t"' },
    { text: async () => '<error><ticket>t</ticket><pass_ticket>p</pass_ticket><skey>s</skey><wxsid>sid</wxsid><wxuin>123</wxuin></error>' },
    { json: async () => ({ BaseResponse: { Ret: 0 }, User: { UserName: '@bot', Alias: 'alice', NickName: 'Alice', HeadImgUrl: '/avatar' } }) },
  ]
  const provider = new WeixinWebProvider({ now: () => 1000, fetchImpl: async (url, options) => { calls.push({ url, options }); return responses[n++] } })
  const qr = await provider.createBindingQr({ userId: 'tenant-a' })
  assert.match(qr.qrPayload, /u-1/)
  assert.equal((await provider.getBindingStatus({ bindingRef: qr.bindingRef })).status, 'scanned')
  const bound = await provider.getBindingStatus({ bindingRef: qr.bindingRef })
  assert.equal(bound.profile.username, 'alice')
  assert.equal(bound.profile.nickname, 'Alice')
  assert.equal(calls.length, 5)
})
