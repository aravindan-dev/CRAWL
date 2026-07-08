export interface LicensePayload {
  schema: 1;
  productId: "clg-search";
  edition: "server";
  licenseId: string;
  customerName: string;
  customerEmail: string;
  issuedAt: string; // ISO date
  expiresAt: string; // ISO date
  maxUniversities: number | null; // null = unlimited
  maxUsers: number | null; // null = unlimited
  machineFingerprint: string | null; // null until activated (pre-activation key)
}

export type LicenseErrorCode =
  | "LICENSE_MISSING"
  | "LICENSE_MALFORMED"
  | "LICENSE_INVALID_SIGNATURE"
  | "LICENSE_EXPIRED"
  | "LICENSE_IN_GRACE"
  | "LICENSE_MACHINE_MISMATCH"
  | "LICENSE_NOT_ACTIVATED"
  | "LICENSE_WRONG_PRODUCT"
  | "LICENSE_PRE_ACTIVATION_EXPIRED"
  | "LICENSE_CLOCK_TAMPER";

export type LicenseStatus =
  | { state: "valid"; payload: LicensePayload; daysLeft: number }
  | { state: "grace"; payload: LicensePayload; graceDaysLeft: number }
  | { state: "invalid"; code: LicenseErrorCode; message: string };
