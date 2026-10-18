# inbound-guard

**Is this email automated cold outreach? A score, a verdict and the reasons.**

```bash
npx @analyzemail/inbound-guard message.eml
```

Most businesses do not send cold email. They receive it, more of it every month, written
and followed up by software that never gets tired. inbound-guard reads an incoming
message and says whether it was sent the way cold outreach is sent: from a spare domain,
through a sequencing tool, in a series of nudges. A CLI for mail rules and scripts, an MCP
server for the agent that reads your inbox, and a library for everything else.

Zero dependencies. Nothing about your mail leaves your machine.

---

## What it looks at

| Signal | How | Points |
|---|---|---|
| **Sequencing tool** | Links, tracking images or headers from Instantly, Smartlead, lemlist, Apollo, Outreach, Salesloft, HubSpot Sales, Mailshake, Reply.io, Woodpecker, Yesware, Mixmax, GMass, QuickMail, Saleshandy, Klenty or Snov.io | +40 |
| **Hidden tracking image** | A 1x1 or invisible image, when no known tool was found | +15 |
| **Look-alike sending domain** | The sender's domain website redirects to another company's domain, and contains its name (`getacme.io` to `acme.com`) | +30 |
| **Domain redirects elsewhere** | The website redirects to an unrelated domain | +20 |
| **New domain** | Registered under 30 days ago (+25), 90 days (+20) or a year (+10), from public RDAP records | +10 to +25 |
| **Replies go elsewhere** | `Reply-To` on a different domain from `From` | +15 |
| **Fake reply** | A `Re:` or `Fwd:` subject with no thread headers | +20 |
| **Unfilled merge field** | `{{first_name}}`, `[Company]`, `%FIRSTNAME%` | +25 |
| **Sales sequence wording** | "just bumping this", "circling back", "worth a quick chat?", "15 minutes", "who is the right person" | +8 each, up to +24 |
| **Not one of your contacts** | With `--contacts`, a sender not on it | +10 |
| **Known contact** | With `--contacts`, a sender or domain on it | -50 |
| **Newsletter or mailing list** | `List-Id` or `Precedence: bulk` | -30 |

The score is the sum, from 0 to 100. **60 or more is cold**, 35 to 59 is **likely cold**,
below that is **not cold**.

## Example

```
$ npx @analyzemail/inbound-guard message.eml

COLD  score 100
  From     dana@getacme.io
  Subject  Quick question about your onboarding

  Sent with a sequencing tool   lemlist  +40
  New domain                    getacme.io registered 23 days ago  +25
  Look-alike sending domain     getacme.io redirects to acme.com  +30
  Replies go to another domain  sent from getacme.io, replies to acme.com  +15
  Sales sequence wording        "Worth a quick chat", "15 minutes", "I came across your"  +24
```

A whole mailbox export:

```
$ npx @analyzemail/inbound-guard inbox.mbox --offline
cold      79  dana@getacme.io  Quick question about your onboarding
not_cold   8  priya@example.com  Re: Q4 budget
cold      69  jordan@trynorthwind.com  Re: {{company}} partnership
not_cold   0  news@bigpaper.com  This week — the news

4 messages: 2 cold, 0 likely cold, 2 not cold
```

## Options

```
--contacts <file>  Addresses or domains you already deal with, one per line.
--offline          Skip the domain age and website lookups.
--fail-on <level>  Exit 1 at this verdict or worse: cold (default) or likely.
--json             Machine-readable output.
--no-colour        Plain text.
```

Input is a `.eml` file, an mbox export, or a message on standard input (`-`).

Exit code `0` means not cold, `1` means cold, `2` means it could not run. So it fits a mail
rule or a procmail/sieve pipe:

```bash
inbound-guard - --fail-on likely < message.eml || mv message.eml cold/
```

## For agents: MCP server

```bash
npx @analyzemail/inbound-guard mcp
```

```json
{
  "mcpServers": {
    "inbound-guard": { "command": "npx", "args": ["-y", "@analyzemail/inbound-guard", "mcp"] }
  }
}
```

One tool, `check_message`: the raw message or the path of a `.eml` file, and optionally
the person's contacts. It tells the agent not to reply on the person's behalf to a cold
message, and to show a likely one to the person with the reasons.

## Library

```js
import { checkMessage } from '@analyzemail/inbound-guard'

const result = await checkMessage(rawMessage, { contacts: ['acme.com'] })
// { verdict, score, signals: [{ code, label, detail, weight }], from, subject, domain, notes }
```

## What it does not do

**It does not move or delete mail.** It gives a verdict; your rule or your agent decides
what happens next.

**It does not send your mail anywhere.** Messages are read on your machine. The only
network requests are the sending domain's RDAP record (via [rdap.org](https://rdap.org),
or `INBOUND_GUARD_RDAP_URL`) and its home page, to see where it redirects. `--offline`
turns both off. A lookup that fails counts for nothing.

**It does not judge the offer.** A cold message can be one you want. The score says how a
message was sent, not whether it is worth reading.

**It is not a spam or phishing filter.** That is your mail provider's job. inbound-guard is
for the outreach that gets past it.

**It cannot see custom tracking domains.** Most sequencing tools let a sender use their
own tracking domain. The hidden-image and domain checks catch many of those; not all.

## Related

- [Analyzemail](https://analyzemail.com/inbound): the other direction too. Verify a list
  before you send to it, by API or [MCP server](https://github.com/analyzemail/mcp).
- [send-guard](https://github.com/askeleven/send-guard) and
  [loop-breaker](https://github.com/askeleven/loop-breaker), from our partner
  [AskEleven](https://askeleven.com): checks for agents that send.

## License

MIT
