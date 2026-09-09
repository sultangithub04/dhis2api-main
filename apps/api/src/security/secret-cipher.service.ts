import { Injectable } from "@nestjs/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getConfig } from "../config.js";

export interface EncryptedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

@Injectable()
export class SecretCipherService {
  private readonly key: Buffer;

  constructor() {
    this.key = Buffer.from(getConfig().CONNECTION_ENCRYPTION_KEY, "base64");
    if (this.key.length !== 32) {
      throw new Error("CONNECTION_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
    }
  }

  encrypt(value: unknown): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final()
    ]);
    return { ciphertext, iv, tag: cipher.getAuthTag() };
  }

  decrypt<T>(secret: EncryptedSecret): T {
    const decipher = createDecipheriv("aes-256-gcm", this.key, secret.iv);
    decipher.setAuthTag(secret.tag);
    const plaintext = Buffer.concat([
      decipher.update(secret.ciphertext),
      decipher.final()
    ]).toString("utf8");
    return JSON.parse(plaintext) as T;
  }
}

