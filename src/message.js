/**
 * Just enough RFC 5322 / MIME to read a message the way inbound-guard needs it: the
 * headers, the plain text, and the links and images in the HTML.
 */

/**
 * @typedef {object} Message
 * @property {Map<string, string[]>} headers Lower-cased name to every value, unfolded.
 * @property {string} from The sender's address, lower-cased, or ''.
 * @property {string} fromName
 * @property {string} subject
 * @property {string} text Plain text: the text/plain part, or the HTML with tags removed.
 * @property {string} html
 */

/**
 * @param {string} raw A whole message: headers, a blank line, the body.
 * @returns {Message}
 */
export function parseMessage(raw) {
  const { headers, body } = splitHeaders(raw.replace(/\r\n/g, '\n'))
  const parts = { text: '', html: '' }
  collectParts(headers, body, parts, 0)

  const fromHeader = first(headers, 'from')
  const { address, name } = parseAddress(fromHeader)
  const text = parts.text || htmlToText(parts.html)
  return {
    headers,
    from: address,
    fromName: name,
    subject: decodeWords(first(headers, 'subject')),
    text,
    html: parts.html,
  }
}

/**
 * Splits an mbox export into raw messages.
 *
 * @param {string} mbox
 * @returns {string[]}
 */
export function splitMbox(mbox) {
  return mbox
    .replace(/\r\n/g, '\n')
    .split(/^From .*\n/m)
    .map((m) => m.replace(/^>(>*From )/gm, '$1'))
    .filter((m) => m.trim())
}

/**
 * @param {Map<string, string[]>} headers
 * @param {string} name
 */
export function first(headers, name) {
  return headers.get(name)?.[0] ?? ''
}

/** @param {string} text */
function splitHeaders(text) {
  const end = text.search(/\n\n/)
  const head = end === -1 ? text : text.slice(0, end)
  const body = end === -1 ? '' : text.slice(end + 2)
  /** @type {Map<string, string[]>} */
  const headers = new Map()
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = utf8(line.slice(colon + 1).trim())
    headers.set(name, [...(headers.get(name) ?? []), value])
  }
  return { headers, body }
}

/**
 * Raw 8-bit header bytes arrive one character per byte; most senders mean UTF-8.
 *
 * @param {string} value
 */
function utf8(value) {
  if (!/[\x80-\xff]/.test(value)) return value
  const decoded = Buffer.from(value, 'latin1').toString('utf8')
  return decoded.includes('\uFFFD') ? value : decoded
}

/**
 * @param {Map<string, string[]>} headers
 * @param {string} body
 * @param {{ text: string, html: string }} parts
 * @param {number} depth
 */
function collectParts(headers, body, parts, depth) {
  const contentType = first(headers, 'content-type') || 'text/plain'
  const type = contentType.split(';')[0].trim().toLowerCase()

  if (type.startsWith('multipart/') && depth < 10) {
    const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1]
    if (!boundary) return
    const delimiter = `--${boundary}`
    for (const chunk of body.split(delimiter).slice(1)) {
      if (chunk.startsWith('--')) break
      const part = splitHeaders(chunk.replace(/^\n/, ''))
      collectParts(part.headers, part.body, parts, depth + 1)
    }
    return
  }
  if (type !== 'text/plain' && type !== 'text/html') return

  const charset = /charset="?([^";]+)"?/i.exec(contentType)?.[1]
  const decoded = decodeBody(body, first(headers, 'content-transfer-encoding'), charset)
  if (type === 'text/plain' && !parts.text) parts.text = decoded
  if (type === 'text/html' && !parts.html) parts.html = decoded
}

/**
 * @param {string} body
 * @param {string} encoding
 * @param {string | undefined} charset
 */
function decodeBody(body, encoding, charset) {
  const enc = encoding.trim().toLowerCase()
  /** @type {Buffer} */
  let bytes
  if (enc === 'base64') bytes = Buffer.from(body.replace(/\s+/g, ''), 'base64')
  else if (enc === 'quoted-printable') bytes = decodeQuotedPrintable(body)
  else bytes = Buffer.from(body, 'latin1')
  return toText(bytes, charset)
}

/**
 * @param {Buffer} bytes
 * @param {string | undefined} charset
 */
function toText(bytes, charset) {
  try {
    return new TextDecoder(charset?.toLowerCase() || 'utf-8').decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** @param {string} text */
function decodeQuotedPrintable(text) {
  const joined = text.replace(/=\n/g, '')
  const bytes = []
  for (let i = 0; i < joined.length; i++) {
    const hex = joined.slice(i + 1, i + 3)
    if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      i += 2
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff)
    }
  }
  return Buffer.from(bytes)
}

/**
 * Decodes RFC 2047 encoded words, as in `Subject: =?UTF-8?B?...?=`.
 *
 * @param {string} value
 */
export function decodeWords(value) {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, enc, data) => {
      const bytes =
        enc.toUpperCase() === 'B'
          ? Buffer.from(data, 'base64')
          : decodeQuotedPrintable(data.replace(/_/g, ' '))
      return toText(bytes, charset)
    })
}

/**
 * @param {string} value A From header.
 * @returns {{ address: string, name: string }}
 */
export function parseAddress(value) {
  const decoded = decodeWords(value)
  const angle = /<([^>]+)>/.exec(decoded)
  const address = (angle ? angle[1] : (/[^\s<>"]+@[^\s<>"]+/.exec(decoded)?.[0] ?? '')).trim()
  const name = angle ? decoded.slice(0, angle.index).trim().replace(/^"|"$/g, '') : ''
  return { address: address.toLowerCase(), name }
}

/** @param {string} html */
export function htmlToText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, ' ')
}

/**
 * Hostnames of every link and image in the HTML, and links in the text.
 *
 * @param {Message} message
 * @returns {{ links: string[], images: { host: string, tiny: boolean }[] }}
 */
export function references(message) {
  const links = new Set()
  for (const m of message.html.matchAll(/href\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi)) {
    links.add(host(m[1]))
  }
  for (const m of message.text.matchAll(/https?:\/\/[^\s<>")]+/gi)) links.add(host(m[0]))

  const images = []
  for (const m of message.html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0]
    const src = /src\s*=\s*["']?(https?:\/\/[^"'\s>]+)/i.exec(tag)?.[1]
    if (!src) continue
    const width = /width\s*=\s*["']?(\d+)/i.exec(tag)?.[1]
    const height = /height\s*=\s*["']?(\d+)/i.exec(tag)?.[1]
    const tiny =
      (Number(width) <= 1 && Number(height) <= 1 && width !== undefined) ||
      /display\s*:\s*none|width\s*:\s*[01]px/i.test(tag)
    images.push({ host: host(src), tiny })
  }
  links.delete('')
  return { links: [...links], images }
}

/** @param {string} url */
function host(url) {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}
