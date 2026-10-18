/**
 * The human-readable report for one result.
 *
 * @param {import('./check.js').Result} result
 * @param {{ colour?: boolean }} [options]
 */
export function formatResult(result, options = {}) {
  const paint = (/** @type {string} */ code, /** @type {string} */ text) =>
    options.colour ? `\x1b[${code}m${text}\x1b[0m` : text
  const heading = {
    cold: paint('1;31', 'COLD'),
    likely: paint('1;33', 'LIKELY COLD'),
    not_cold: paint('1;32', 'NOT COLD'),
  }[result.verdict]

  const lines = [`${heading}  score ${result.score}`, `  From     ${result.from || '(none)'}`, `  Subject  ${result.subject || '(none)'}`, '']
  const width = Math.max(0, ...result.signals.map((s) => s.label.length))
  for (const s of result.signals) {
    const sign = s.weight > 0 ? `+${s.weight}` : `${s.weight}`
    lines.push(`  ${s.label.padEnd(width)}  ${s.detail}  ${paint('2', sign)}`)
  }
  if (!result.signals.length) lines.push('  No signs of automated outreach.')
  for (const note of result.notes) lines.push('', `  ${paint('2', note)}`)
  return `${lines.join('\n')}\n`
}
