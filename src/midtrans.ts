/**
 * Minimal Midtrans HTTP client.
 *
 * Auth: HTTP Basic with the Server Key as username and an empty password,
 * exactly as documented by Midtrans. The key is read from the environment
 * and never logged.
 */

export interface MidtransConfig {
  serverKey: string;
  isProduction: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MidtransConfig {
  const serverKey = env.MIDTRANS_SERVER_KEY?.trim();
  if (!serverKey) {
    throw new Error(
      "MIDTRANS_SERVER_KEY is not set. Get your Server Key from the Midtrans dashboard " +
        "(Settings > Access Keys) and pass it as an environment variable. " +
        "Use a Sandbox key for testing."
    );
  }
  const isProduction = /^(1|true|yes)$/i.test(env.MIDTRANS_IS_PRODUCTION?.trim() ?? "");
  return { serverKey, isProduction };
}

export function coreBaseUrl(isProduction: boolean): string {
  return isProduction ? "https://api.midtrans.com" : "https://api.sandbox.midtrans.com";
}

export function snapBaseUrl(isProduction: boolean): string {
  return isProduction
    ? "https://app.midtrans.com/snap/v1"
    : "https://app.sandbox.midtrans.com/snap/v1";
}

/** Basic-auth header value for a Midtrans Server Key (exported for tests). */
export function authHeader(serverKey: string): string {
  return "Basic " + Buffer.from(`${serverKey}:`).toString("base64");
}

/** Hard cap on how much of a Midtrans response body we read/return (64 KiB). */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Every API call is aborted after this long, so a hung connection cannot hang the agent. */
const REQUEST_TIMEOUT_MS = 30_000;

export class MidtransApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    const detail =
      body && typeof body === "object"
        ? JSON.stringify(body)
        : String(body ?? "");
    super(`Midtrans API error (HTTP ${status})${detail ? `: ${detail}` : ""}`);
    this.name = "MidtransApiError";
    this.status = status;
    this.body = body;
  }
}

export class MidtransClient {
  private readonly cfg: MidtransConfig;

  constructor(cfg: MidtransConfig) {
    this.cfg = cfg;
  }

  private async request(
    base: string,
    path: string,
    init: { method: "GET" | "POST"; body?: unknown } = { method: "GET" }
  ): Promise<unknown> {
    const url = `${base}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: authHeader(this.cfg.serverKey),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller.signal,
        redirect: "error",
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Midtrans request timed out after ${REQUEST_TIMEOUT_MS / 1000}s (${path})`);
      }
      // Note: only the path is reported — never the URL query or any header,
      // so the Server Key can never leak through an error message.
      throw new Error(
        `Could not reach Midtrans (${path}): ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      clearTimeout(timer);
    }

    const rawText = await res.text();
    const text =
      rawText.length > MAX_RESPONSE_BYTES
        ? rawText.slice(0, MAX_RESPONSE_BYTES) + "\n…[response truncated]"
        : rawText;
    let parsed: unknown = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep raw text */
      }
    }
    // Midtrans signals many errors with an HTTP 2xx plus status_code in the
    // body, and real HTTP errors for others. Treat any HTTP >= 400 as an
    // error; body-level status codes are returned to the caller as data.
    if (res.status >= 400) {
      throw new MidtransApiError(res.status, parsed);
    }
    return parsed;
  }

  /** GET /v2/{order_id}/status */
  getTransactionStatus(orderId: string): Promise<unknown> {
    return this.request(
      coreBaseUrl(this.cfg.isProduction),
      `/v2/${encodeURIComponent(orderId)}/status`
    );
  }

  /** POST /v2/{order_id}/cancel */
  cancelTransaction(orderId: string): Promise<unknown> {
    return this.request(
      coreBaseUrl(this.cfg.isProduction),
      `/v2/${encodeURIComponent(orderId)}/cancel`,
      { method: "POST", body: {} }
    );
  }

  /** POST /v2/{order_id}/refund */
  refundTransaction(
    orderId: string,
    opts: { amount?: number; reason?: string; refundKey?: string } = {}
  ): Promise<unknown> {
    const body: Record<string, unknown> = {};
    if (opts.amount !== undefined) body.amount = opts.amount;
    if (opts.reason !== undefined) body.reason = opts.reason;
    if (opts.refundKey !== undefined) body.refund_key = opts.refundKey;
    return this.request(
      coreBaseUrl(this.cfg.isProduction),
      `/v2/${encodeURIComponent(orderId)}/refund`,
      { method: "POST", body }
    );
  }

  /** POST {snap}/transactions — creates a Snap transaction, returns token + redirect_url. */
  createSnapTransaction(payload: Record<string, unknown>): Promise<unknown> {
    return this.request(snapBaseUrl(this.cfg.isProduction), `/transactions`, {
      method: "POST",
      body: payload,
    });
  }

  /** POST /v1/payment-links */
  createPaymentLink(payload: Record<string, unknown>): Promise<unknown> {
    return this.request(coreBaseUrl(this.cfg.isProduction), `/v1/payment-links`, {
      method: "POST",
      body: payload,
    });
  }
}
