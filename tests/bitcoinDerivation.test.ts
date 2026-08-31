import { describe, expect, it } from "vitest";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import {
  BITCOIN_MAINNET,
  BITCOIN_SIGNET,
  BITCOIN_TESTNET4,
  findBitcoinNetwork,
} from "@/core/bitcoin/bitcoinNetwork";
import {
  createBitcoinAccountBasePath,
  createBitcoinDerivationPath,
  createBitcoinRelativePath,
} from "@/core/bitcoin/derivationPath";
import {
  deriveBitcoinAddress,
  deriveBitcoinAddressSummary,
  isValidBitcoinAddress,
} from "@/core/bitcoin/bitcoinAccount";
import {
  createUnlockedKeyring,
  deriveBitcoinAccountPublicNode,
  withBitcoinAccountPrivateKey,
  LOCKED_KEYRING,
} from "@/core/keyring/keyring";
import { VaultLockedError } from "@/core/vault/vaultErrors";

/**
 * Official BIP-0084 test vectors (bitcoin/bips/bip-0084.mediawiki)
 *
 * Mnemonic: abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about
 * Coin type 0' (Mainnet):
 * Account 0 root path: m/84'/0'/0'
 * Account 0 xpub: zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs
 *
 * First receive address (m/84'/0'/0'/0/0): bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu
 * Second receive address (m/84'/0'/0'/0/1): bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g
 * First change address (m/84'/0'/0'/1/0): bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el
 */
const BIP84_TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("Bitcoin BIP-84 Derivation & Addressing", () => {
  describe("Derivation Paths", () => {
    it("constructs account base paths correctly", () => {
      expect(createBitcoinAccountBasePath({ coinType: 0, accountIndex: 0 })).toBe(
        "m/84'/0'/0'",
      );
      expect(createBitcoinAccountBasePath({ coinType: 1, accountIndex: 0 })).toBe(
        "m/84'/1'/0'",
      );
      expect(createBitcoinAccountBasePath({ coinType: 0, accountIndex: 2 })).toBe(
        "m/84'/0'/2'",
      );
    });

    it("constructs full address derivation paths", () => {
      expect(
        createBitcoinDerivationPath({
          coinType: 0,
          accountIndex: 0,
          branch: 0,
          addressIndex: 0,
        }),
      ).toBe("m/84'/0'/0'/0/0");

      expect(
        createBitcoinDerivationPath({
          coinType: 0,
          accountIndex: 0,
          branch: 1,
          addressIndex: 5,
        }),
      ).toBe("m/84'/0'/0'/1/5");

      expect(
        createBitcoinDerivationPath({
          coinType: 1,
          accountIndex: 0,
          branch: 0,
          addressIndex: 3,
        }),
      ).toBe("m/84'/1'/0'/0/3");
    });

    it("constructs relative paths", () => {
      expect(createBitcoinRelativePath({ branch: 0, addressIndex: 0 })).toBe("m/0/0");
      expect(createBitcoinRelativePath({ branch: 1, addressIndex: 12 })).toBe("m/1/12");
    });
  });

  describe("BIP-84 Official Known-Answer Test Vectors", () => {
    const seed = mnemonicToSeedSync(BIP84_TEST_MNEMONIC);
    const masterNode = HDKey.fromMasterSeed(seed);
    const accountNode = masterNode.derive("m/84'/0'/0'");
    const neuteredAccountNode = HDKey.fromExtendedKey(accountNode.publicExtendedKey);

    it("derives the exact BIP-84 first receive address (0/0)", () => {
      const address = deriveBitcoinAddress({
        accountNode: neuteredAccountNode,
        branch: 0,
        addressIndex: 0,
        network: BITCOIN_MAINNET,
      });
      expect(address).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    });

    it("derives the exact BIP-84 second receive address (0/1)", () => {
      const address = deriveBitcoinAddress({
        accountNode: neuteredAccountNode,
        branch: 0,
        addressIndex: 1,
        network: BITCOIN_MAINNET,
      });
      expect(address).toBe("bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g");
    });

    it("derives the exact BIP-84 first change address (1/0)", () => {
      const address = deriveBitcoinAddress({
        accountNode: neuteredAccountNode,
        branch: 1,
        addressIndex: 0,
        network: BITCOIN_MAINNET,
      });
      expect(address).toBe("bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el");
    });

    it("derives complete address summaries with public keys and paths", () => {
      const summary = deriveBitcoinAddressSummary({
        accountNode: neuteredAccountNode,
        branch: 0,
        addressIndex: 0,
        network: BITCOIN_MAINNET,
        accountIndex: 0,
      });
      expect(summary.address).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
      expect(summary.derivationPath).toBe("m/84'/0'/0'/0/0");
      expect(summary.branch).toBe(0);
      expect(summary.addressIndex).toBe(0);
      expect(summary.publicKeyHex).toBeTruthy();
    });

    it("derives testnet/signet addresses with tb1q prefix", () => {
      const signetAccountNode = masterNode.derive("m/84'/1'/0'");
      const neuteredSignetNode = HDKey.fromExtendedKey(
        signetAccountNode.publicExtendedKey,
      );

      const signetAddress = deriveBitcoinAddress({
        accountNode: neuteredSignetNode,
        branch: 0,
        addressIndex: 0,
        network: BITCOIN_SIGNET,
      });
      expect(signetAddress.startsWith("tb1q")).toBe(true);
      expect(signetAddress).toBe("tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl");
    });
  });

  describe("Address Validation", () => {
    it("validates mainnet vs signet addresses", () => {
      const mainnetAddr = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
      const signetAddr = "tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl";

      expect(isValidBitcoinAddress(mainnetAddr, BITCOIN_MAINNET)).toBe(true);
      expect(isValidBitcoinAddress(mainnetAddr, BITCOIN_SIGNET)).toBe(false);

      expect(isValidBitcoinAddress(signetAddr, BITCOIN_SIGNET)).toBe(true);
      expect(isValidBitcoinAddress(signetAddr, BITCOIN_MAINNET)).toBe(false);

      expect(isValidBitcoinAddress("not-an-address", BITCOIN_MAINNET)).toBe(false);
      expect(isValidBitcoinAddress("", BITCOIN_MAINNET)).toBe(false);
    });
  });

  describe("Keyring Integration", () => {
    const keyring = createUnlockedKeyring({
      payload: {
        version: 1,
        keyringSources: [
          {
            id: "hd-source-1",
            type: "hd",
            mnemonic: BIP84_TEST_MNEMONIC,
            passphrase: "",
            accountCount: 1,
          },
        ],
      },
    });

    it("derives neutered public node from unlocked keyring without leaking private key", () => {
      const publicNode = deriveBitcoinAccountPublicNode({
        keyring,
        accountIndex: 0,
        network: "mainnet",
      });

      // Public node can derive addresses
      const address = deriveBitcoinAddress({
        accountNode: publicNode,
        branch: 0,
        addressIndex: 0,
        network: BITCOIN_MAINNET,
      });
      expect(address).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");

      // Public node has no private key
      expect(publicNode.privateKey).toBeNull();
    });

    it("fails with VaultLockedError when locked", () => {
      expect(() =>
        deriveBitcoinAccountPublicNode({
          keyring: LOCKED_KEYRING,
          accountIndex: 0,
          network: "mainnet",
        }),
      ).toThrow(VaultLockedError);
    });

    it("lends private key temporarily and wipes it", async () => {
      let capturedKey: Uint8Array | undefined;
      await withBitcoinAccountPrivateKey({
        keyring,
        accountIndex: 0,
        branch: 0,
        addressIndex: 0,
        network: "mainnet",
        operation: (pk) => {
          capturedKey = pk;
          expect(pk.length).toBe(32);
          expect(pk.some((b) => b !== 0)).toBe(true);
        },
      });

      // After operation settles, the captured buffer is wiped (all zeroes)
      expect(capturedKey).toBeDefined();
      expect(capturedKey!.every((b) => b === 0)).toBe(true);
    });
  });
});
