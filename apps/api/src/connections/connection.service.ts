import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  type ConnectionSummary,
  type ConnectionTestResult,
  type CreateConnectionInput,
  type UpdateConnectionInput
} from "@dhis-sync/contracts";
import {
  Dhis2Client,
  type Dhis2Credential,
  normalizeDhis2BaseUrl
} from "@dhis-sync/dhis2-client";
import { SecretCipherService } from "../security/secret-cipher.service.js";
import { ConnectionRepository, type StoredConnection } from "./connection.repository.js";

type StoredCredential = Dhis2Credential;

function publicSummary(connection: StoredConnection): ConnectionSummary {
  const { ciphertext: _ciphertext, iv: _iv, tag: _tag, ...safe } = connection;
  return safe;
}

@Injectable()
export class ConnectionService {
  constructor(
    @Inject(ConnectionRepository) private readonly repository: ConnectionRepository,
    @Inject(SecretCipherService) private readonly cipher: SecretCipherService
  ) {}

  private credentialFromInput(input: CreateConnectionInput): StoredCredential {
    if (input.authType === "pat" && input.apiToken) {
      return { type: "pat", apiToken: input.apiToken.trim() };
    }
    if (input.authType === "basic" && input.username && input.password) {
      return { type: "basic", username: input.username.trim(), password: input.password };
    }
    throw new BadRequestException("Credentials do not match the selected authentication type");
  }

  private client(
    baseUrl: string,
    credential: StoredCredential,
    dhis2Version?: string | null,
    timeoutMs?: number
  ): Dhis2Client {
    return new Dhis2Client({
      baseUrl,
      credential,
      ...(dhis2Version === undefined ? {} : { dhis2Version }),
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
  }

  private async runConnectionTest(
    baseUrl: string,
    credential: StoredCredential
  ): Promise<ConnectionTestResult> {
    try {
      return await this.client(baseUrl, credential, undefined, 15_000).testConnection();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection test failed";
      throw new BadRequestException(message);
    }
  }

  async list(): Promise<ConnectionSummary[]> {
    return (await this.repository.list()).map(publicSummary);
  }

  async getAuthenticatedClient(id: string): Promise<Dhis2Client> {
    const stored = await this.repository.findById(id);
    if (!stored) throw new NotFoundException("Connection not found");
    const credential = this.cipher.decrypt<StoredCredential>({
      ciphertext: stored.ciphertext,
      iv: stored.iv,
      tag: stored.tag
    });
    return this.client(stored.baseUrl, credential, stored.dhis2Version);
  }

  async getSummary(id: string): Promise<ConnectionSummary> {
    const stored = await this.repository.findById(id);
    if (!stored) throw new NotFoundException("Connection not found");
    return publicSummary(stored);
  }

  async testUnsaved(input: CreateConnectionInput): Promise<ConnectionTestResult> {
    return this.runConnectionTest(input.baseUrl, this.credentialFromInput(input));
  }

  async create(input: CreateConnectionInput): Promise<ConnectionSummary> {
    const existing = await this.repository.findByName(input.name);
    if (existing) {
      throw new ConflictException(
        `A connection named "${existing.name}" already exists. Use its Retest action or choose a different name`
      );
    }
    const credential = this.credentialFromInput(input);
    const normalizedBaseUrl = normalizeDhis2BaseUrl(input.baseUrl);
    const test = input.testBeforeSave
      ? await this.runConnectionTest(normalizedBaseUrl, credential)
      : null;
    let stored: StoredConnection;
    try {
      stored = await this.repository.insert({
        name: input.name.trim(),
        role: input.role,
        baseUrl: normalizedBaseUrl,
        authType: input.authType,
        encryptedSecret: this.cipher.encrypt(credential),
        test
      });
    } catch (error) {
      const databaseError = error as { code?: string; constraint?: string };
      if (databaseError.code === "23505" && databaseError.constraint === "dhis2_connections_name_unique") {
        throw new ConflictException(
          `A connection named "${input.name.trim()}" already exists. Use its Retest action or choose a different name`
        );
      }
      throw error;
    }
    return publicSummary(stored);
  }

  async update(id: string, input: UpdateConnectionInput): Promise<ConnectionSummary> {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException("Connection not found");
    const duplicate = await this.repository.findByName(input.name);
    if (duplicate && duplicate.id !== id) throw new ConflictException(`A connection named "${duplicate.name}" already exists`);

    let credential: StoredCredential;
    const supplied = input.authType === "pat"
      ? Boolean(input.apiToken?.trim())
      : Boolean(input.username?.trim() && input.password);
    if (supplied) {
      credential = this.credentialFromInput({ ...input, testBeforeSave: true } as CreateConnectionInput);
    } else {
      if (input.authType !== existing.authType) throw new BadRequestException("Enter new credentials when changing the authentication type");
      credential = this.cipher.decrypt<StoredCredential>({ ciphertext: existing.ciphertext, iv: existing.iv, tag: existing.tag });
    }
    const baseUrl = normalizeDhis2BaseUrl(input.baseUrl);
    const test = input.testAfterSave ? await this.runConnectionTest(baseUrl, credential) : null;
    try {
      return publicSummary(await this.repository.update({
        id, name: input.name.trim(), role: input.role, baseUrl, authType: input.authType,
        encryptedSecret: this.cipher.encrypt(credential), test, isActive: input.isActive
      }));
    } catch (error) {
      const databaseError = error as { code?: string };
      if (databaseError.code === "23505") throw new ConflictException(`A connection named "${input.name.trim()}" already exists`);
      throw error;
    }
  }

  async testSaved(id: string): Promise<ConnectionSummary> {
    const stored = await this.repository.findById(id);
    if (!stored) throw new NotFoundException("Connection not found");
    const credential = this.cipher.decrypt<StoredCredential>({
      ciphertext: stored.ciphertext,
      iv: stored.iv,
      tag: stored.tag
    });
    try {
      const test = await this.client(stored.baseUrl, credential, stored.dhis2Version, 15_000).testConnection();
      return publicSummary(await this.repository.recordTest(id, test));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connection test failed";
      await this.repository.recordFailure(id, message);
      throw new BadRequestException(message);
    }
  }

  async delete(id: string, confirmation: string): Promise<{ deleted: true }> {
    const stored = await this.repository.findById(id);
    if (!stored) throw new NotFoundException("Connection not found");
    if (confirmation !== stored.name) throw new BadRequestException(`Type ${stored.name} to confirm deletion`);
    const dependencies = await this.repository.dependencyCounts(id);
    if (dependencies.syncDefinitions || dependencies.blueprints) {
      throw new ConflictException(
        `Delete ${dependencies.syncDefinitions} sync definition(s) and ${dependencies.blueprints} schema blueprint(s) that use this connection first`
      );
    }
    if (!await this.repository.delete(id)) throw new NotFoundException("Connection not found");
    return { deleted: true };
  }
}
