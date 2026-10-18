import { VERSION } from './version.js'

/** Some RDAP services refuse requests without a named client. */
const USER_AGENT = `inbound-guard/${VERSION} (+https://github.com/analyzemail/inbound-guard)`

/**
 * What can be learned about the sending domain from public sources: when it was
 * registered (RDAP) and where its website goes.
 */

/** Second-level suffixes under which a registrable domain has three labels. */
const TWO_PART_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'org.nz', 'co.za', 'com.br', 'com.mx',
  'co.jp', 'ne.jp', 'or.jp', 'co.in', 'firm.in', 'net.in', 'co.kr', 'com.cn',
  'com.sg', 'com.hk', 'com.tr', 'com.ar', 'com.co', 'co.il', 'com.my', 'co.id',
])

/** Mailbox providers anyone can sign up to; their age and website say nothing. */
export const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me',
  'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com',
  'fastmail.com', 'hey.com',
])

/**
 * The domain someone registered: `mail.acme.co.uk` gives `acme.co.uk`.
 *
 * @param {string} hostname
 */
export function registrableDomain(hostname) {
  const labels = hostname.toLowerCase().replace(/\.$/, '').split('.')
  if (labels.length <= 2) return labels.join('.')
  const lastTwo = labels.slice(-2).join('.')
  return TWO_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo
}

/** The first label of a registrable domain: `acme` for `acme.co.uk`. */
export function brandLabel(/** @type {string} */ domain) {
  return domain.split('.')[0]
}

/**
 * @typedef {object} DomainFacts
 * @property {Date | null} registered
 * @property {string | null} redirectsTo Registrable domain the website redirects to,
 *   when that is a different domain.
 */

/**
 * @typedef {object} LookupOptions
 * @property {typeof fetch} [fetch]
 * @property {number} [timeoutMs]
 * @property {string} [rdapUrl] Base of an RDAP bootstrap service.
 */

/**
 * Looks up the domain's registration date and website redirect. Each lookup that
 * fails resolves null rather than throwing: a missing fact is not evidence.
 *
 * @param {string} domain A registrable domain.
 * @param {LookupOptions} [options]
 * @returns {Promise<DomainFacts>}
 */
export async function lookupDomain(domain, options = {}) {
  const { fetch: fetchImpl = globalThis.fetch, timeoutMs = 8000 } = options
  const rdapUrl = (options.rdapUrl ?? process.env.INBOUND_GUARD_RDAP_URL ?? 'https://rdap.org').replace(/\/+$/, '')
  const [registered, redirectsTo] = await Promise.all([
    registrationDate(domain, rdapUrl, fetchImpl, timeoutMs),
    websiteRedirect(domain, fetchImpl, timeoutMs),
  ])
  return { registered, redirectsTo }
}

/**
 * @param {string} domain
 * @param {string} rdapUrl
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 */
async function registrationDate(domain, rdapUrl, fetchImpl, timeoutMs) {
  try {
    const response = await fetchImpl(`${rdapUrl}/domain/${encodeURIComponent(domain)}`, {
      headers: { Accept: 'application/rdap+json, application/json', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return null
    const json = /** @type {any} */ (await response.json())
    const event = (json.events ?? []).find((/** @type {any} */ e) => e.eventAction === 'registration')
    const date = event ? new Date(event.eventDate) : null
    return date && !Number.isNaN(date.getTime()) ? date : null
  } catch {
    return null
  }
}

/**
 * Follows up to five redirects from the domain's home page and returns the registrable
 * domain it ends on, when that differs.
 *
 * @param {string} domain
 * @param {typeof fetch} fetchImpl
 * @param {number} timeoutMs
 */
async function websiteRedirect(domain, fetchImpl, timeoutMs) {
  for (const start of [`https://${domain}/`, `https://www.${domain}/`]) {
    let url = start
    try {
      for (let hop = 0; hop < 5; hop++) {
        const response = await fetchImpl(url, {
          method: 'GET',
          redirect: 'manual',
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(timeoutMs),
        })
        const location = response.headers.get('location')
        if (response.status >= 300 && response.status < 400 && location) {
          url = new URL(location, url).toString()
          continue
        }
        break
      }
      const end = registrableDomain(new URL(url).hostname)
      return end === domain ? null : end
    } catch {
      // Try www., then give up: no website is not evidence either way.
    }
  }
  return null
}
