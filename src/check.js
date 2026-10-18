import { parseMessage, references, first } from './message.js'
import { registrableDomain, brandLabel, lookupDomain, FREE_PROVIDERS } from './domain.js'

/**
 * Sequencing tools and the domains their links, tracking images or headers use. Many
 * of them also let a sender use a custom tracking domain, which this cannot see; the
 * tracking-pixel check catches some of those.
 */
export const SEQUENCERS = [
  ['Instantly', ['instantly.ai']],
  ['Smartlead', ['smartlead.ai']],
  ['lemlist', ['lemlist.com', 'lemlist.io']],
  ['Apollo', ['apollo.io']],
  ['Outreach', ['outreach.io']],
  ['Salesloft', ['salesloft.com']],
  ['HubSpot Sales', ['sidekickopen']],
  ['Mailshake', ['mailshake.com']],
  ['Reply.io', ['reply.io']],
  ['Woodpecker', ['woodpecker.co']],
  ['Yesware', ['yesware.com']],
  ['Mixmax', ['mixmax.com']],
  ['GMass', ['gmass.co']],
  ['QuickMail', ['quickmail.io']],
  ['Saleshandy', ['saleshandy.com']],
  ['Klenty', ['klenty.com']],
  ['Snov.io', ['snov.io']],
]

/** Headers where a sequencing tool's name or domain shows up. */
const TOOL_HEADERS = ['x-mailer', 'message-id', 'list-unsubscribe', 'x-campaign', 'x-campaign-id']

/** The nudges and openers of a sequence. Each match adds weight, up to a cap. */
const SEQUENCE_PHRASES = [
  /\bjust (bumping|following up|circling back|checking in|floating)\b/i,
  /\b(bumping|floating) (this|my (last|previous) (email|note|message))\b/i,
  /\bcircl(e|ing) back\b/i,
  /\bfollowing up on my (last|previous|earlier)\b/i,
  /\b(did|have) you (get|had|have) a chance\b/i,
  /\bquick question\b/i,
  /\b(worth|open to|up for) a (quick |brief |short )?(chat|call|conversation)\b/i,
  /\b(10|15|20|ten|fifteen|twenty)[ -]?min(ute)?s?\b/i,
  /\bwho('s| is) the (right|best) person\b/i,
  /\bany thoughts on my (last|previous)\b/i,
  /\bI (came across|noticed|saw) (your|that you)\b/i,
  /\bif (this|it) (isn'?t|is not) a (priority|fit)\b/i,
]

const MERGE_FIELD =
  /\{\{\s*[\w.]+\s*\}\}|\{\s*(first_?name|last_?name|company|company_?name|name)\s*\}|\[\s*(first ?name|last ?name|company|company name|your name|name)\s*\]|%[A-Z][A-Z_]{2,}%/i

export const COLD_AT = 60
export const LIKELY_AT = 35

/**
 * @typedef {object} Signal
 * @property {string} code
 * @property {string} label
 * @property {string} detail
 * @property {number} weight Positive points towards cold, negative away from it.
 *
 * @typedef {object} Result
 * @property {string} from
 * @property {string} subject
 * @property {string} domain The sender's registrable domain.
 * @property {number} score 0 to 100.
 * @property {'cold'|'likely'|'not_cold'} verdict
 * @property {Signal[]} signals
 * @property {string[]} notes
 *
 * @typedef {object} CheckOptions
 * @property {Iterable<string>} [contacts] Addresses or domains you already deal with.
 * @property {boolean} [lookups] Look up the domain's age and website. Default true.
 * @property {import('./domain.js').LookupOptions} [lookupOptions]
 * @property {Date} [now]
 */

/**
 * Scores one message as cold outreach.
 *
 * @param {string} raw The whole message, as in a .eml file.
 * @param {CheckOptions} [options]
 * @returns {Promise<Result>}
 */
export async function checkMessage(raw, options = {}) {
  const message = parseMessage(raw)
  const now = options.now ?? new Date()
  const domain = message.from ? registrableDomain(message.from.split('@')[1] ?? '') : ''
  /** @type {Signal[]} */
  const signals = []
  const notes = []
  const add = (/** @type {Signal} */ s) => signals.push(s)

  // Sequencing tools
  const { links, images } = references(message)
  const headerText = TOOL_HEADERS.flatMap((h) => message.headers.get(h) ?? []).join(' ').toLowerCase()
  const hosts = [...links, ...images.map((i) => i.host)]
  const tool = SEQUENCERS.find(([, domains]) =>
    domains.some((d) => headerText.includes(d) || hosts.some((h) => h === d || h.endsWith(`.${d}`) || h.includes(d))),
  )
  if (tool) {
    add({ code: 'sequencer', label: 'Sent with a sequencing tool', detail: tool[0], weight: 40 })
  } else {
    const pixel = images.find((i) => i.tiny)
    if (pixel) {
      add({ code: 'tracking_pixel', label: 'Hidden tracking image', detail: pixel.host, weight: 15 })
    }
  }

  // The sending domain
  const free = FREE_PROVIDERS.has(domain)
  if (domain && !free && options.lookups !== false) {
    const facts = await lookupDomain(domain, options.lookupOptions)
    if (facts.registered) {
      const days = Math.floor((now.getTime() - facts.registered.getTime()) / 86_400_000)
      const weight = days < 30 ? 25 : days < 90 ? 20 : days < 365 ? 10 : 0
      if (weight) {
        add({ code: 'new_domain', label: 'New domain', detail: `${domain} registered ${days} days ago`, weight })
      }
    } else {
      notes.push(`The registration date of ${domain} could not be found.`)
    }
    if (facts.redirectsTo) {
      const lookAlike = domain !== facts.redirectsTo && domain.includes(brandLabel(facts.redirectsTo))
      add({
        code: 'look_alike_domain',
        label: lookAlike ? 'Look-alike sending domain' : 'Sending domain redirects elsewhere',
        detail: `${domain} redirects to ${facts.redirectsTo}`,
        weight: lookAlike ? 30 : 20,
      })
    }
  } else if (domain && !free) {
    notes.push('Domain lookups were skipped, so domain age and website redirects were not checked.')
  }

  const replyTo = /[^\s<>"]+@([^\s<>",]+)/.exec(first(message.headers, 'reply-to'))?.[1]
  if (replyTo && domain && !free) {
    const replyDomain = registrableDomain(replyTo)
    if (replyDomain !== domain && !FREE_PROVIDERS.has(replyDomain)) {
      add({
        code: 'reply_elsewhere',
        label: 'Replies go to another domain',
        detail: `sent from ${domain}, replies to ${replyDomain}`,
        weight: 15,
      })
    }
  }

  // The words
  const isReply = message.headers.has('in-reply-to') || message.headers.has('references')
  if (/^\s*(re|fw|fwd)\s*:/i.test(message.subject) && !isReply) {
    add({ code: 'fake_reply', label: 'Re: on a thread that never started', detail: message.subject, weight: 20 })
  }
  const merge = MERGE_FIELD.exec(`${message.subject}\n${message.text}`)
  if (merge) add({ code: 'merge_field', label: 'Unfilled merge field', detail: merge[0], weight: 25 })

  const phrases = SEQUENCE_PHRASES.map((re) => re.exec(message.text)?.[0]).filter(Boolean)
  if (phrases.length) {
    add({
      code: 'sequence_phrases',
      label: 'Sales sequence wording',
      detail: phrases.slice(0, 3).map((p) => `"${p}"`).join(', '),
      weight: Math.min(phrases.length * 8, 24),
    })
  }

  // Who it is from
  const contacts = new Set([...(options.contacts ?? [])].map((c) => c.trim().toLowerCase()).filter(Boolean))
  if (contacts.size) {
    if (contacts.has(message.from) || contacts.has(domain)) {
      add({ code: 'known_contact', label: 'Known contact', detail: message.from, weight: -50 })
    } else {
      add({ code: 'first_contact', label: 'Not one of your contacts', detail: message.from, weight: 10 })
    }
  }

  // Mailing lists are not cold outreach
  const precedence = first(message.headers, 'precedence').toLowerCase()
  if (message.headers.has('list-id') || precedence === 'bulk' || precedence === 'list') {
    add({ code: 'mailing_list', label: 'Newsletter or mailing list', detail: 'List-Id or Precedence header', weight: -30 })
  }

  const score = Math.max(0, Math.min(100, signals.reduce((sum, s) => sum + s.weight, 0)))
  const verdict = score >= COLD_AT ? 'cold' : score >= LIKELY_AT ? 'likely' : 'not_cold'
  return { from: message.from, subject: message.subject, domain, score, verdict, signals, notes }
}
