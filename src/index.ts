#!/usr/bin/env node
/**
 * midtrans-mcp — an MCP server for the Midtrans payment gateway (Indonesia).
 *
 * Configuration (environment variables):
 *   MIDTRANS_SERVER_KEY     (required) your Midtrans Server Key.
 *   MIDTRANS_IS_PRODUCTION  "true" for production, anything else = Sandbox.
 *   MIDTRANS_READ_ONLY      "true" registers ONLY the read-only status tool;
 *                           create/cancel/refund tools are not exposed at all.
 *
 * Security notes:
 * - The Server Key is only ever read from the environment and sent to
 *   api(.sandbox).midtrans.com / app(.sandbox).midtrans.com over HTTPS.
 * - Nothing is logged to stdout (stdout is the MCP transport). Diagnostics
 *   go to stderr, and error messages never contain the key or headers.
 * - All inputs are validated (order_id charset/length, integer IDR amounts
 *   with a sane ceiling) before anything reaches the API.
 * - Refund and cancel are explicit, separate tools — they are never called
 *   implicitly by any other tool.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, MidtransClient } from "./midtrans.js";

function textResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: err instanceof Error ? err.message : String(err),
      },
    ],
  };
}

async function run(fn: () => Promise<unknown>) {
  try {
    return textResult(await fn());
  } catch (err) {
    return errorResult(err);
  }
}

const customerDetails = z
  .object({
    first_name: z.string().max(100).optional(),
    last_name: z.string().max(100).optional(),
    email: z.string().email().max(254).optional(),
    phone: z.string().max(32).optional(),
  })
  .optional();

const itemDetail = z.object({
  id: z.string().max(50).optional(),
  name: z.string().min(1).max(100),
  price: z.number().int().nonnegative().max(999_999_999_999),
  quantity: z.number().int().positive().max(100_000),
});

/** Midtrans order ids use a restricted charset; enforce it before any URL is built. */
const orderIdLookup = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/, "order_id may only contain letters, digits, '.', '_' and '-'");
/** New transactions: Midtrans limits order_id to 50 characters. */
const orderIdCreate = orderIdLookup.refine((s) => s.length <= 50, {
  message: "order_id for a new transaction is limited to 50 characters",
});
/** IDR amounts are integers; the ceiling keeps absurd values out. */
const idrAmount = z.number().int().positive().max(999_999_999_999);

const isTruthy = (v: string | undefined) => /^(1|true|yes)$/i.test(v?.trim() ?? "");

async function main(): Promise<void> {
  const client = new MidtransClient(loadConfig());
  const readOnly = isTruthy(process.env.MIDTRANS_READ_ONLY);
  const isProduction = isTruthy(process.env.MIDTRANS_IS_PRODUCTION);

  const server = new McpServer({
    name: "midtrans-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "get_transaction_status",
    {
      title: "Get transaction status",
      description:
        "Check the current status of a Midtrans transaction by its order_id. " +
        "Returns the full status object from Midtrans (transaction_status, fraud_status, " +
        "payment_type, gross_amount, status_code, and more). Read-only.",
      inputSchema: {
        order_id: orderIdLookup.describe("The order_id of the transaction to check."),
      },
    },
    async ({ order_id }) => run(() => client.getTransactionStatus(order_id))
  );

  if (!readOnly) {
  server.registerTool(
    "create_snap_transaction",
    {
      title: "Create Snap transaction",
      description:
        "Create a Midtrans Snap transaction and get back a token and redirect_url " +
        "for the Snap payment page. gross_amount is in IDR (integer).",
      inputSchema: {
        order_id: orderIdCreate.describe("Unique order id for this transaction."),
        gross_amount: idrAmount.describe("Total amount in IDR (integer, no decimals)."),
        customer_details: customerDetails.describe(
          "Optional customer information shown on the Snap page."
        ),
        item_details: z
          .array(itemDetail)
          .optional()
          .describe(
            "Optional item list. If given, the sum of price*quantity must equal gross_amount."
          ),
        enabled_payments: z
          .array(z.string())
          .optional()
          .describe(
            "Optional list of payment channels to enable, e.g. ['gopay','bca_va','credit_card']."
          ),
      },
    },
    async ({ order_id, gross_amount, customer_details, item_details, enabled_payments }) =>
      run(() =>
        client.createSnapTransaction({
          transaction_details: { order_id, gross_amount },
          ...(customer_details ? { customer_details } : {}),
          ...(item_details ? { item_details } : {}),
          ...(enabled_payments ? { enabled_payments } : {}),
        })
      )
  );

  server.registerTool(
    "create_payment_link",
    {
      title: "Create payment link",
      description:
        "Create a reusable Midtrans Payment Link and return its URL. " +
        "The customer opens the URL to pay. Amount is in IDR (integer).",
      inputSchema: {
        title: z.string().min(1).max(100).describe("Title shown on the payment page."),
        amount: idrAmount.describe("Amount in IDR (integer, no decimals)."),
        description: z
          .string()
          .max(500)
          .optional()
          .describe("Optional description shown on the payment page."),
        customer_required: z
          .boolean()
          .optional()
          .describe("Whether the customer must fill in their details."),
        usage_limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional maximum number of times the link can be paid."),
        expiry_duration: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Optional link validity length, combined with expiry_unit."),
        expiry_unit: z
          .enum(["minutes", "hours", "days"])
          .optional()
          .describe("Unit for expiry_duration (default: days)."),
      },
    },
    async ({ title, amount, description, customer_required, usage_limit, expiry_duration, expiry_unit }) =>
      run(() =>
        client.createPaymentLink({
          title,
          amount,
          ...(description ? { description } : {}),
          ...(customer_required !== undefined ? { customer_required } : {}),
          ...(usage_limit !== undefined ? { usage_limit } : {}),
          ...(expiry_duration !== undefined
            ? { expiry: { duration: expiry_duration, unit: expiry_unit ?? "days" } }
            : {}),
        })
      )
  );

  server.registerTool(
    "cancel_transaction",
    {
      title: "Cancel transaction",
      description:
        "Cancel a Midtrans transaction by order_id. Only works for transactions " +
        "that can still be cancelled (e.g. pending payments). This changes real " +
        "state in the merchant account — use deliberately.",
      inputSchema: {
        order_id: orderIdLookup.describe("The order_id to cancel."),
      },
    },
    async ({ order_id }) => run(() => client.cancelTransaction(order_id))
  );

  server.registerTool(
    "refund_transaction",
    {
      title: "Refund transaction",
      description:
        "Refund a settled Midtrans transaction by order_id. Omit amount for a " +
        "full refund. This moves real money back to the customer — use deliberately.",
      inputSchema: {
        order_id: orderIdLookup.describe("The order_id to refund."),
        amount: idrAmount
          .optional()
          .describe("Refund amount in IDR. Omit for a full refund."),
        reason: z.string().max(255).optional().describe("Optional refund reason."),
        refund_key: z
          .string()
          .max(100)
          .optional()
          .describe(
            "Optional idempotency key so a retried refund is not applied twice."
          ),
      },
    },
    async ({ order_id, amount, reason, refund_key }) =>
      run(() =>
        client.refundTransaction(order_id, {
          amount,
          reason,
          refundKey: refund_key,
        })
      )
  );
  } // end if (!readOnly)

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `midtrans-mcp running (stdio). Mode: ${isProduction ? "PRODUCTION" : "sandbox"}, read-only: ${readOnly}`
  );
  if (isProduction && !readOnly) {
    console.error(
      "WARNING: production key with write tools enabled — refunds and cancels move real money. " +
        "Set MIDTRANS_READ_ONLY=true if this assistant only needs to check transactions."
    );
  }
}

main().catch((err) => {
  console.error("midtrans-mcp failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
