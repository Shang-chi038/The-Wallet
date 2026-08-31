/**
 * Vault error taxonomy.
 *
 * Every error carries a stable `code` so the UI can branch on it without
 * string-matching messages. Messages are user-facing and must never include
 * secret material, partial plaintext, or detail that distinguishes a wrong
 * password from tampered storage.
 */

export class VaultLockedError extends Error {
  readonly code = "vault_locked";
  constructor() {
    super("The wallet is locked.");
    this.name = "VaultLockedError";
  }
}

export class VaultNotFoundError extends Error {
  readonly code = "vault_not_found";
  constructor() {
    super("No wallet has been created on this device.");
    this.name = "VaultNotFoundError";
  }
}

export class VaultAlreadyExistsError extends Error {
  readonly code = "vault_already_exists";
  constructor() {
    super("A wallet already exists on this device.");
    this.name = "VaultAlreadyExistsError";
  }
}

export class IncorrectPasswordError extends Error {
  readonly code = "incorrect_password";
  constructor() {
    super("Incorrect password.");
    this.name = "IncorrectPasswordError";
  }
}

export class VaultCorruptedError extends Error {
  readonly code = "vault_corrupted";
  constructor(detail?: string) {
    super(`The stored wallet data is unreadable.${detail ? ` (${detail})` : ""}`);
    this.name = "VaultCorruptedError";
  }
}

export class UnsupportedVaultVersionError extends Error {
  readonly code = "unsupported_vault_version";
  constructor(version: unknown) {
    super(
      `This wallet data was written by a newer version of the extension (v${String(version)}).`,
    );
    this.name = "UnsupportedVaultVersionError";
  }
}
