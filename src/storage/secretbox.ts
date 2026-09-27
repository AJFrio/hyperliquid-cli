import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Authenticated encryption for the on-disk key fallback.
 *
 * scrypt cost: N=2^17, r=8, p=1 is the OWASP floor. Node's `scrypt` defaults to
 * maxmem=32MiB, and 128*N*r at N=2^17 needs 128MiB, so we MUST raise maxmem or
 * the call throws "memory limit exceeded". We measured this on Node 24.
 */
export const SCRYPT_N = 131_072;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
const KEY_LEN = 32;
const IV_LEN = 12;
/** 128*N*r is 128MiB at N=2^17; leave headroom. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export interface SealedBox {
  v: 1;
  kdf: "scrypt";
  N: number;
  r: number;
  p: number;
  salt: string;
  iv: string;
  tag: string;
  ct: string;
}

export function seal(plaintext: string, passphrase: string): string {
  const salt = randomBytes(16);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const box: SealedBox = {
    v: 1,
    kdf: "scrypt",
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ct: ct.toString("hex"),
  };
  return `${JSON.stringify(box, null, 2)}\n`;
}

export function open_(sealed: string, passphrase: string): string {
  const box = JSON.parse(sealed) as SealedBox;
  if (box.v !== 1 || box.kdf !== "scrypt") {
    throw new Error(`unsupported keystore format: v=${String(box.v)} kdf=${String(box.kdf)}`);
  }
  const key = deriveKey(passphrase, Buffer.from(box.salt, "hex"), box.N, box.r, box.p);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "hex"));
  decipher.setAuthTag(Buffer.from(box.tag, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(box.ct, "hex")), decipher.final()]).toString(
    "utf8",
  );
}

function deriveKey(
  passphrase: string,
  salt: Buffer,
  N = SCRYPT_N,
  r = SCRYPT_R,
  p = SCRYPT_P,
): Buffer {
  return scryptSync(passphrase.normalize("NFKC"), salt, KEY_LEN, {
    N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
}

/** Write via a same-directory temp file so a crash cannot leave a torn secret. */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", mode);
    writeFileSync(fd, data, { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort cleanup */
    }
    throw err;
  }
}

export function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
