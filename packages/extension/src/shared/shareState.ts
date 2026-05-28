/**
 * Shared encode/decode for the `?ld-ext-state=<base64-json>` URL contract.
 *
 * Used by:
 *   - the DevTools panel (build a share URL to copy)
 *   - the ISOLATED-world content script (read an incoming share URL and
 *     forward the payload to the background SW)
 *
 * Anyone with the extension installed who opens a share URL gets the
 * overrides applied for that origin. The page itself never sees or
 * processes the URL parameter — it's owned by the extension end-to-end.
 *
 * Payload shape (v1):
 *   {
 *     version: 1,
 *     overrides: { [flagKey: string]: unknown }
 *   }
 *
 * Future versions may add contexts, settings, etc. Decoder ignores
 * unknown fields and refuses payloads with version > current.
 */

export const SHARE_PARAM_NAME = "ld-ext-state";
export const SHARE_STATE_VERSION = 1 as const;

/** ~8KB matches the official toolbar's hard cap and stays well under URL limits. */
export const MAX_PAYLOAD_BYTES = 8192;

export interface SharedStatePayload {
  version: number;
  overrides: Record<string, unknown>;
}

export interface EncodeResult {
  encoded: string;
  size: number;
  exceedsLimit: boolean;
}

export interface DecodeResult {
  payload: SharedStatePayload | null;
  error: string | null;
}

/**
 * Encode the current override map into a base64 string suitable for a URL
 * query parameter. Unicode-safe via the UTF-8 encode/decode pair.
 */
export function encodeSharedState(
  overrides: Record<string, unknown>,
): EncodeResult {
  const payload: SharedStatePayload = {
    version: SHARE_STATE_VERSION,
    overrides,
  };
  const json = JSON.stringify(payload);
  // Unicode-safe base64: btoa(JSON) breaks on non-ASCII, so go through
  // UTF-8 encoding first.
  const utf8 = unescape(encodeURIComponent(json));
  const encoded = btoa(utf8);
  return {
    encoded,
    size: encoded.length,
    exceedsLimit: encoded.length > MAX_PAYLOAD_BYTES,
  };
}

/**
 * Decode a base64 query-param value into a typed payload, validating the
 * version and shape. Returns `payload: null` on any failure with `error`
 * filled in.
 */
export function decodeSharedState(encoded: string): DecodeResult {
  let json: string;
  try {
    json = decodeURIComponent(escape(atob(encoded)));
  } catch (err) {
    return {
      payload: null,
      error: `Failed to decode base64: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      payload: null,
      error: `Failed to parse JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { payload: null, error: "Payload is not an object" };
  }

  const obj = parsed as Record<string, unknown>;
  if (typeof obj.version !== "number") {
    return { payload: null, error: "Payload is missing version" };
  }
  if (obj.version > SHARE_STATE_VERSION) {
    return {
      payload: null,
      error: `Payload version ${obj.version} is newer than this extension supports (v${SHARE_STATE_VERSION})`,
    };
  }
  if (!obj.overrides || typeof obj.overrides !== "object") {
    return { payload: null, error: "Payload is missing overrides object" };
  }

  return {
    payload: {
      version: obj.version,
      overrides: obj.overrides as Record<string, unknown>,
    },
    error: null,
  };
}

/**
 * Build a full share URL from a base URL and the current override map.
 * Strips any pre-existing instance of the share param to keep things
 * idempotent.
 */
export function buildShareUrl(
  baseUrl: string,
  overrides: Record<string, unknown>,
): { url: string; encoded: EncodeResult } {
  const encoded = encodeSharedState(overrides);
  const url = new URL(baseUrl);
  url.searchParams.set(SHARE_PARAM_NAME, encoded.encoded);
  return { url: url.toString(), encoded };
}

/**
 * If `url` contains the share param, return its decoded payload and a
 * new URL string with the param removed (suitable for history.replaceState).
 */
export function extractSharedState(url: string): {
  payload: SharedStatePayload | null;
  cleanedUrl: string | null;
  error: string | null;
} {
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    return { payload: null, cleanedUrl: null, error: "Invalid URL" };
  }

  const raw = urlObj.searchParams.get(SHARE_PARAM_NAME);
  if (!raw) {
    return { payload: null, cleanedUrl: null, error: null };
  }

  const decoded = decodeSharedState(raw);
  urlObj.searchParams.delete(SHARE_PARAM_NAME);

  return {
    payload: decoded.payload,
    cleanedUrl: urlObj.toString(),
    error: decoded.error,
  };
}
