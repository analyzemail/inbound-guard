#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { checkMessage } from '../src/check.js'
import { splitMbox } from '../src/message.js'
import { formatResult } from '../src/report.js'
import { serve } from '../src/mcp.js'
import { VERSION } from '../src/version.js'

const HELP = `inbound-guard ${VERSION}

Score an incoming email as cold outreach, with the reasons.

  inbound-guard message.eml          one message
  inbound-guard mail.mbox            every message in an mbox export
  cat message.eml | inbound-guard -  a message on standard input
  inbound-guard mcp                  MCP server over stdio

Options
  --contacts <file>  Addresses or domains you already deal with, one per line.
  --offline          Skip the domain age and website lookups.
  --fail-on <level>  Exit 1 at this verdict or worse: cold (default) or likely.
  --json             Machine-readable output.
  --no-colour        Plain text.

Exit code 0: not cold. 1: cold (or likely, with --fail-on likely). 2: could not run.
`

async function main(argv) {
  const args = { files: [], contacts: null, offline: false, json: false, failOn: 'cold', colour: process.stdout.isTTY }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return process.stdout.write(HELP), 0
    if (a === '--version' || a === '-v') return process.stdout.write(`${VERSION}\n`), 0
    if (a === '--contacts') args.contacts = argv[++i]
    else if (a === '--offline') args.offline = true
    else if (a === '--json') args.json = true
    else if (a === '--no-colour' || a === '--no-color') args.colour = false
    else if (a === '--fail-on') args.failOn = argv[++i]
    else if (a.startsWith('--')) throw new Error(`Unknown option: ${a}`)
    else args.files.push(a)
  }
  if (args.files[0] === 'mcp') {
    await serve()
    return 0
  }
  if (!['cold', 'likely'].includes(args.failOn)) throw new Error('--fail-on is cold or likely.')
  if (args.files.length !== 1) {
    process.stderr.write(HELP)
    return 2
  }

  const source = args.files[0] === '-' ? await readStdin() : await readFile(args.files[0], 'latin1')
  const contacts = args.contacts ? (await readFile(args.contacts, 'utf8')).split(/\r?\n/) : undefined
  const messages = /^From \S+/.test(source) ? splitMbox(source) : [source]

  const results = []
  for (const raw of messages) {
    results.push(await checkMessage(raw, { contacts, lookups: !args.offline }))
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify(results.length === 1 ? results[0] : results, null, 2)}\n`)
  } else if (results.length === 1) {
    process.stdout.write(formatResult(results[0], { colour: args.colour }))
  } else {
    for (const r of results) {
      process.stdout.write(`${r.verdict.padEnd(8)} ${String(r.score).padStart(3)}  ${r.from}  ${r.subject}\n`)
    }
    const count = (v) => results.filter((r) => r.verdict === v).length
    process.stdout.write(`\n${results.length} messages: ${count('cold')} cold, ${count('likely')} likely cold, ${count('not_cold')} not cold\n`)
  }

  const failing = args.failOn === 'likely' ? ['cold', 'likely'] : ['cold']
  return results.some((r) => failing.includes(r.verdict)) ? 1 : 0
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('latin1')
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`inbound-guard: ${error.message}\n`)
    process.exitCode = 2
  },
)
