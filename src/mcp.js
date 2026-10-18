import { createInterface } from 'node:readline'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { checkMessage } from './check.js'
import { VERSION } from './version.js'

/**
 * A Model Context Protocol server over stdio, written against the spec directly so the
 * package keeps zero runtime dependencies. Messages are newline-delimited JSON-RPC 2.0.
 */

/** Newest first. The first is offered when a client asks for one we do not know. */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

const MAX_MESSAGE_BYTES = 10 * 1024 * 1024

const INSTRUCTIONS =
  'Call check_message on an incoming email before you answer, forward or act on it ' +
  'when it comes from someone outside the conversation. A cold verdict means automated ' +
  'outreach: do not reply on the person\'s behalf or agree to anything; label or ' +
  'summarise it as the person prefers. likely means show it to the person with the ' +
  'reasons. The score says how a message was sent, not whether it is worth reading.'

const TOOLS = [
  {
    name: 'check_message',
    title: 'Check whether an email is cold outreach',
    description:
      'Scores one incoming email from 0 to 100 as automated cold outreach and returns ' +
      'the verdict (cold, likely, not_cold) and the signals behind it: sequencing tools, ' +
      'hidden tracking images, look-alike or newly registered sending domains, replies ' +
      'sent to another domain, fake Re: subjects, unfilled merge fields and sales ' +
      'sequence wording. Give the raw message (headers and body) or the path of a .eml file.',
    inputSchema: {
      type: 'object',
      properties: {
        raw: { type: 'string', description: 'The whole message: headers, a blank line, the body.' },
        path: { type: 'string', description: 'A .eml file on disk, instead of raw.' },
        contacts: {
          type: 'array',
          items: { type: 'string' },
          description: 'Addresses or domains the person already deals with.',
        },
        lookups: {
          type: 'boolean',
          description: 'Look up the sending domain\'s registration date and website. Default true.',
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
]

/**
 * @typedef {object} ServeOptions
 * @property {NodeJS.ReadableStream} [input]
 * @property {NodeJS.WritableStream} [output]
 * @property {Record<string, string | undefined>} [env]
 * @property {Partial<import('./check.js').CheckOptions>} [checkOptions] Overrides for
 *   tests, such as fake lookups.
 */

/**
 * Serves until the input stream closes.
 *
 * @param {ServeOptions} [options]
 * @returns {Promise<void>}
 */
export function serve(options = {}) {
  const { input = process.stdin, output = process.stdout } = options
  const send = (/** @type {object} */ message) => {
    output.write(`${JSON.stringify(message)}\n`)
  }

  /** @type {Promise<void>[]} */
  const pending = []
  const lines = createInterface({ input, crlfDelay: Infinity })
  lines.on('line', (line) => {
    if (!line.trim()) return
    pending.push(handleLine(line, send, options))
  })
  return new Promise((done) => {
    lines.on('close', () => {
      Promise.all(pending).then(() => done())
    })
  })
}

/**
 * @param {string} line
 * @param {(message: object) => void} send
 * @param {ServeOptions} options
 */
async function handleLine(line, send, options) {
  /** @type {any} */
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }

  const isRequest = message && typeof message === 'object' && 'id' in message
  if (!isRequest) return // Notifications, including notifications/initialized.

  const { id, method, params } = message
  try {
    const result = await dispatch(method, params ?? {}, options)
    send({ jsonrpc: '2.0', id, result })
  } catch (error) {
    const code = error instanceof RpcError ? error.code : -32603
    send({ jsonrpc: '2.0', id, error: { code, message: /** @type {Error} */ (error).message } })
  }
}

class RpcError extends Error {
  /**
   * @param {number} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

class ToolInputError extends Error {}

/**
 * @param {string} method
 * @param {any} params
 * @param {ServeOptions} options
 */
async function dispatch(method, params, options) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion
          : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'inbound-guard', title: 'inbound-guard', version: VERSION },
        instructions: INSTRUCTIONS,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call':
      return callTool(params.name, params.arguments ?? {}, options)
    default:
      throw new RpcError(-32601, `Method not found: ${method}`)
  }
}

/**
 * Tool failures are results with isError set, not protocol errors, so the model sees
 * the message and can act on it.
 *
 * @param {string} name
 * @param {any} args
 * @param {ServeOptions} options
 */
async function callTool(name, args, options) {
  if (name !== 'check_message') throw new RpcError(-32602, `Unknown tool: ${name}`)
  try {
    const raw = await rawMessage(args)
    const result = await checkMessage(raw, {
      contacts: Array.isArray(args.contacts) ? args.contacts.filter((c) => typeof c === 'string') : undefined,
      lookups: args.lookups !== false,
      ...options.checkOptions,
    })
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    }
  } catch (error) {
    if (error instanceof ToolInputError) {
      return { content: [{ type: 'text', text: error.message }], isError: true }
    }
    throw error
  }
}

/**
 * The message as the parser expects it: one character per byte.
 *
 * @param {any} args
 */
async function rawMessage(args) {
  if (typeof args.raw === 'string' && args.raw.trim()) {
    return Buffer.from(args.raw, 'utf8').toString('latin1')
  }
  if (typeof args.path === 'string' && args.path) {
    const path = resolve(args.path)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new ToolInputError(`No such file: ${path}`)
    if (info.size > MAX_MESSAGE_BYTES) throw new ToolInputError(`${path} is over 10 MB.`)
    return readFile(path, 'latin1')
  }
  throw new ToolInputError('Give the message as raw, or the path of a .eml file.')
}
