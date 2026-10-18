import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { checkMessage } from '../src/check.js'
import { parseMessage, splitMbox } from '../src/message.js'
import { registrableDomain, lookupDomain } from '../src/domain.js'
import { serve } from '../src/mcp.js'

const NOW = new Date('2026-10-18T00:00:00Z')
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'latin1')

/**
 * Fake RDAP and websites: registrations maps domain to an ISO date, redirects maps a
 * URL to the Location it answers with.
 */
function fakeWeb({ registrations = {}, redirects = {} } = {}) {
  const calls = []
  const fetch = async (url) => {
    calls.push(url)
    const rdap = /\/domain\/(.+)$/.exec(url)
    if (url.startsWith('https://rdap.test/')) {
      const date = registrations[decodeURIComponent(rdap[1])]
      if (!date) return new Response('{}', { status: 404 })
      return Response.json({ events: [{ eventAction: 'registration', eventDate: date }] })
    }
    if (redirects[url]) return new Response(null, { status: 301, headers: { location: redirects[url] } })
    return new Response('<html></html>', { status: 200 })
  }
  return { fetch, calls }
}

const lookupOptions = (web) => ({ fetch: web.fetch, rdapUrl: 'https://rdap.test' })

test('a sequencer email from a new look-alike domain is cold', async () => {
  const web = fakeWeb({
    registrations: { 'getacme.io': '2026-09-25T00:00:00Z' },
    redirects: { 'https://getacme.io/': 'https://acme.com/' },
  })
  const result = await checkMessage(await fixture('sequencer.eml'), { now: NOW, lookupOptions: lookupOptions(web) })
  assert.equal(result.verdict, 'cold')
  assert.equal(result.score, 100)
  const codes = result.signals.map((s) => s.code)
  assert.deepEqual(codes, ['sequencer', 'new_domain', 'look_alike_domain', 'reply_elsewhere', 'sequence_phrases'])
  assert.equal(result.signals[0].detail, 'lemlist')
  assert.equal(result.signals[1].detail, 'getacme.io registered 23 days ago')
  assert.equal(result.signals[2].detail, 'getacme.io redirects to acme.com')
})

test('a fake reply with a leaked merge field is cold without any lookups', async () => {
  const result = await checkMessage(await fixture('fake-reply.eml'), { now: NOW, lookups: false })
  assert.equal(result.verdict, 'cold')
  const codes = result.signals.map((s) => s.code)
  assert.deepEqual(codes, ['fake_reply', 'merge_field', 'sequence_phrases'])
  assert.equal(result.signals[1].detail, '{{company}}')
  assert.match(result.notes[0], /lookups were skipped/)
})

test('a reply from a known colleague is not cold', async () => {
  const web = fakeWeb({ registrations: { 'example.com': '1995-08-14T04:00:00Z' } })
  const result = await checkMessage(await fixture('colleague.eml'), {
    now: NOW,
    contacts: ['example.com'],
    lookupOptions: lookupOptions(web),
  })
  assert.equal(result.verdict, 'not_cold')
  assert.equal(result.score, 0)
  assert.ok(result.signals.some((s) => s.code === 'known_contact'))
})

test('a newsletter with a tracking image is not cold', async () => {
  const web = fakeWeb({ registrations: { 'bigpaper.com': '2001-01-01T00:00:00Z' } })
  const result = await checkMessage(await fixture('newsletter.eml'), { now: NOW, lookupOptions: lookupOptions(web) })
  assert.equal(result.verdict, 'not_cold')
  assert.equal(result.subject, 'This week — the news')
  assert.deepEqual(result.signals.map((s) => s.code), ['tracking_pixel', 'mailing_list'])
})

test('free mailbox providers are not looked up', async () => {
  const web = fakeWeb()
  const raw = 'From: someone@gmail.com\nSubject: hello\n\nhi'
  const result = await checkMessage(raw, { now: NOW, lookupOptions: lookupOptions(web) })
  assert.equal(web.calls.length, 0)
  assert.equal(result.verdict, 'not_cold')
})

test('failed lookups are not evidence', async () => {
  const fetch = async () => {
    throw new Error('offline')
  }
  const facts = await lookupDomain('acme.com', { fetch, rdapUrl: 'https://rdap.test' })
  assert.deepEqual(facts, { registered: null, redirectsTo: null })
})

test('registrable domains', () => {
  assert.equal(registrableDomain('mail.acme.co.uk'), 'acme.co.uk')
  assert.equal(registrableDomain('a.b.acme.com'), 'acme.com')
  assert.equal(registrableDomain('acme.io'), 'acme.io')
})

test('parsing: quoted-printable, base64, encoded words, mbox', async () => {
  const seq = parseMessage(await fixture('sequencer.eml'))
  assert.equal(seq.from, 'dana@getacme.io')
  assert.equal(seq.fromName, 'Dana Price')
  assert.match(seq.text, /next week would do/)
  const reply = parseMessage(await fixture('fake-reply.eml'))
  assert.match(reply.text, /Just bumping this/)

  const mbox = `From a@x.com Mon Oct 12 09:00:00 2026\n${await fixture('colleague.eml')}\nFrom b@y.com Mon Oct 12 10:00:00 2026\n${await fixture('fake-reply.eml')}`
  const messages = splitMbox(mbox)
  assert.equal(messages.length, 2)
  assert.equal(parseMessage(messages[1]).from, 'jordan@trynorthwind.com')
})

test('MCP check_message', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let text = ''
  output.on('data', (c) => (text += c))
  const done = serve({ input, output, checkOptions: { now: NOW, lookups: false } })
  const raw = await readFile(new URL('./fixtures/fake-reply.eml', import.meta.url), 'utf8')
  for (const [id, method, params] of [
    [1, 'initialize', { protocolVersion: '2025-06-18' }],
    [2, 'tools/list', {}],
    [3, 'tools/call', { name: 'check_message', arguments: { raw } }],
    [4, 'tools/call', { name: 'check_message', arguments: {} }],
  ]) {
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  }
  input.end()
  await done
  const res = Object.fromEntries(text.trim().split('\n').map((l) => [JSON.parse(l).id, JSON.parse(l)]))
  assert.equal(res[1].result.serverInfo.name, 'inbound-guard')
  assert.deepEqual(res[2].result.tools.map((t) => t.name), ['check_message'])
  assert.equal(res[3].result.structuredContent.verdict, 'cold')
  assert.equal(res[4].result.isError, true)
})
