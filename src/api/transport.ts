import { ApiError, NetworkError } from "../errors.js";

export const MAINNET_API_URL = "https://api.hyperliquid.xyz";
export const TESTNET_API_URL = "https://api.hyperliquid-testnet.xyz";

export function apiUrlFor(testnet: boolean): string {
  return testnet ? TESTNET_API_URL : MAINNET_API_URL;
}

/** POST /info for read calls. The bare host 404s - the path is required. */
export function infoUrl(testnet: boolean): string {
  return `${apiUrlFor(testnet)}/info`;
}

/** POST /exchange for signed actions. */
export function exchangeUrl(testnet: boolean): string {
  return `${apiUrlFor(testnet)}/exchange`;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * POST JSON to the Hyperliquid API and return the parsed body.
 *
 * This deliberately does NOT use `response.json()`. The API returns
 * `Content-Type: text/plain` for errors (e.g. HTTP 422 with body
 * "Failed to deserialize the JSON body into the target type"), so calling
 * `.json()` throws an opaque SyntaxError and destroys the real message.
 * We read text, try to parse, and surface the raw text on failure.
 */
export async function postJson<T>(
  url: string,
  body: unknown,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch | undefined } = {},
): Promise<T> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // AbortError, DNS failure, TLS failure, offline, ...
    const reason = err instanceof Error ? err.message : String(err);
    throw new NetworkError(`request to ${url} failed: ${reason}`, { url });
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();

  if (!res.ok) {
    throw new ApiError(`HTTP ${res.status} from ${url}: ${truncate(text)}`, {
      status: res.status,
      url,
      body: truncate(text),
    });
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    // A 2xx that is not JSON means something is wrong upstream; do not
    // silently hand back a string where the caller expects an object.
    throw new ApiError(`non-JSON 2xx body from ${url}: ${truncate(text)}`, {
      status: res.status,
      url,
      body: truncate(text),
    });
  }
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
