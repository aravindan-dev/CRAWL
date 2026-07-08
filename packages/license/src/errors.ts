import type { LicenseErrorCode } from "./types.js";

export class LicenseError extends Error {
  code: LicenseErrorCode;
  constructor(code: LicenseErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "LicenseError";
  }
}

const VENDOR_CONTACT_HINT = "Contact your vendor for assistance.";

export const LICENSE_ERROR_MESSAGES: Record<LicenseErrorCode, string> = {
  LICENSE_MISSING: `No license was found for this installation. ${VENDOR_CONTACT_HINT}`,
  LICENSE_MALFORMED: `The license file is not readable. It may be corrupted or incomplete. ${VENDOR_CONTACT_HINT}`,
  LICENSE_INVALID_SIGNATURE: `This license could not be verified. It may have been altered or was not issued for this product. ${VENDOR_CONTACT_HINT}`,
  LICENSE_EXPIRED: `This license has expired. ${VENDOR_CONTACT_HINT} to renew.`,
  LICENSE_IN_GRACE: `This license has expired but is within its grace period. ${VENDOR_CONTACT_HINT} to renew soon.`,
  LICENSE_MACHINE_MISMATCH: `This license was activated on a different machine. Each license permits one server. Please contact your vendor to transfer the license.`,
  LICENSE_NOT_ACTIVATED: `This license has not been activated on this machine yet. Please activate it from the License page.`,
  LICENSE_WRONG_PRODUCT: `This license key is not valid for this product. ${VENDOR_CONTACT_HINT}`,
  LICENSE_PRE_ACTIVATION_EXPIRED: `This license key has expired before being activated. It is only valid for a limited time after issue. ${VENDOR_CONTACT_HINT} for a new key.`,
  LICENSE_CLOCK_TAMPER: `System clock appears to have been changed. Please correct the server time or contact your vendor.`,
};
