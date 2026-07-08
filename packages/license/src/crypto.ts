import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { LicenseError } from "./errors.js";
import { LICENSE_PUBLIC_KEY_PEM } from "./publicKey.js";
import type { LicensePayload } from "./types.js";

/**
 * Wire format (professional, copy-paste friendly):
 *
 *   -----BEGIN CLG SEARCH LICENSE-----
 *   <base64( JSON payload )>.<base64( ed25519 signature )>
 *   -----END CLG SEARCH LICENSE-----
 */
const HEADER = "-----BEGIN CLG SEARCH LICENSE-----";
const FOOTER = "-----END CLG SEARCH LICENSE-----";

function extractBody(keyString: string): string {
  const trimmed = keyString.trim();
  if (trimmed.startsWith(HEADER)) {
    const withoutHeader = trimmed.slice(HEADER.length);
    const footerIdx = withoutHeader.indexOf(FOOTER);
    return (footerIdx >= 0 ? withoutHeader.slice(0, footerIdx) : withoutHeader).trim();
  }
  return trimmed;
}

export function signLicense(payload: LicensePayload, privateKeyPem: string): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const key = createPrivateKey(privateKeyPem);
  const sig = edSign(null, Buffer.from(payloadB64, "utf8"), key);
  const sigB64 = sig.toString("base64");
  return `${HEADER}\n${payloadB64}.${sigB64}\n${FOOTER}`;
}

export function verifyLicense(keyString: string, publicKeyPem: string = LICENSE_PUBLIC_KEY_PEM): LicensePayload {
  if (!keyString || typeof keyString !== "string") {
    throw new LicenseError("LICENSE_MISSING", "No license was found for this installation.");
  }
  const body = extractBody(keyString);
  const parts = body.split(".");
  if (parts.length !== 2) {
    throw new LicenseError("LICENSE_MALFORMED", "The license file is not readable. It may be corrupted or incomplete.");
  }
  const [payloadB64, sigB64] = parts as [string, string];

  let ok = false;
  try {
    const key = createPublicKey(publicKeyPem);
    ok = edVerify(null, Buffer.from(payloadB64, "utf8"), key, Buffer.from(sigB64, "base64"));
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new LicenseError("LICENSE_INVALID_SIGNATURE", "This license could not be verified. It may have been altered or was not issued for this product.");
  }

  let payload: LicensePayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8")) as LicensePayload;
  } catch {
    throw new LicenseError("LICENSE_MALFORMED", "The license payload is corrupt.");
  }

  if (payload.productId !== "clg-search") {
    throw new LicenseError("LICENSE_WRONG_PRODUCT", "This license key is not valid for this product.");
  }

  return payload;
}
