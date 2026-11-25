# midtrans-mcp

An [MCP](https://modelcontextprotocol.io) server for **Midtrans**, Indonesia's
payment gateway. Let your AI coding client or assistant check transactions,
create Snap checkouts and payment links, cancel, and refund — without leaving
your editor.

> Unofficial community project. Not affiliated with Midtrans / GoTo Financial.
> Midtrans has no official MCP server; this fills the gap.

## Tools

| Tool | What it does | Changes state |
| --- | --- | --- |
| `get_transaction_status` | Full status of a transaction by `order_id` | No |
| `create_snap_transaction` | Create a Snap transaction, returns token + `redirect_url` | Yes |
| `create_payment_link` | Create a Payment Link and return its URL | Yes |
| `cancel_transaction` | Cancel a cancellable transaction | Yes |
| `refund_transaction` | Refund a settled transaction (full or partial) | Yes — moves money |

## Quick start

You need a Midtrans **Server Key** (dashboard → *Settings → Access Keys*).
Start with a **Sandbox** key while testing.

### Claude Code

```bash
claude mcp add midtrans \
  -e MIDTRANS_SERVER_KEY=SB-Mid-server-xxxxxxxx \
  -- npx -y midtrans-mcp
```

### Cursor / other MCP clients (`mcp.json`)

```json
{
  "mcpServers": {
    "midtrans": {
      "command": "npx",
      "args": ["-y", "midtrans-mcp"],
      "env": {
        "MIDTRANS_SERVER_KEY": "SB-Mid-server-xxxxxxxx"
      }
    }
  }
}
```

### Run from source

```bash
git clone https://github.com/ryoangriawan96/midtrans-mcp.git
cd midtrans-mcp
npm install
npm run build
MIDTRANS_SERVER_KEY=SB-Mid-server-xxxxxxxx node dist/index.js
```

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MIDTRANS_SERVER_KEY` | Yes | — | Your Midtrans Server Key. Sandbox keys start with `SB-`. |
| `MIDTRANS_IS_PRODUCTION` | No | `false` | Set to `true` to hit the production API. Anything else means Sandbox. |
| `MIDTRANS_READ_ONLY` | No | `false` | Set to `true` to expose **only** `get_transaction_status`. Create/cancel/refund tools are not registered at all. Recommended whenever the assistant only needs to look things up — and strongly recommended with a production key. |

## Example prompts

- “Check the status of order `ORDER-123`.”
- “Create a Snap transaction for order `ORDER-124`, Rp150.000, GoPay and BCA VA only.”
- “Make a payment link titled ‘Kelas Online — November’ for Rp299.000, valid 3 days.”
- “Refund order `ORDER-100` in full, reason: customer cancelled.”

## Security

- The Server Key is read **only** from the environment and is sent **only** to
  Midtrans over HTTPS. It is never logged, and error messages never contain
  the key or request headers.
- **Read-only mode:** set `MIDTRANS_READ_ONLY=true` and only the status-check
  tool exists — the AI physically cannot create, cancel, or refund anything.
- Refund and cancel are separate, explicit tools. Nothing calls them
  implicitly, and your MCP client will ask for approval before running them if
  you keep tool approvals on (recommended for production keys).
- All inputs are validated before any request is made: `order_id` is limited
  to Midtrans's character set and length, IDR amounts must be positive
  integers under a sane ceiling, and free-text fields are length-capped.
- Every API call has a 30-second timeout, redirects are refused, and
  responses are size-capped before being handed to the model.
- Use a **Sandbox key** while developing. Treat a production Server Key like
  a password: anyone holding it can refund your customers.

## Development

```bash
npm install
npm run build   # type-check + compile to dist/
npm test        # smoke test: starts the server, lists tools, checks auth header
```

## License

MIT © Ryo Angriawan
