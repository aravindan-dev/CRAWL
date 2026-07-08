export type { LicensePayload, LicenseErrorCode, LicenseStatus } from "./types.js";
export { LicenseError, LICENSE_ERROR_MESSAGES } from "./errors.js";
export { getMachineFingerprint } from "./fingerprint.js";
export { signLicense, verifyLicense } from "./crypto.js";
export { LICENSE_PUBLIC_KEY_PEM } from "./publicKey.js";
export {
  checkLicense,
  activateLicense,
  licenseFileExists,
  GRACE_PERIOD_DAYS,
  PRE_ACTIVATION_VALID_DAYS,
} from "./verify.js";
