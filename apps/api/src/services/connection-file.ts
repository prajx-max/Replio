import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import {
  IdSchema,
  ProviderOptionsSchema,
  ProviderConfigurationSchema,
} from '@assistant/contracts';
import { ServiceFailure } from '../providers/llm/provider.js';

const SavedConnectionSchema = ProviderOptionsSchema.safeExtend({
  profileId: IdSchema,
  apiKey: ProviderConfigurationSchema.shape.apiKey.unwrap(),
  token: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
});
const SavedConnectionsSchema = z.array(SavedConnectionSchema).max(32);
export type SavedConnection = z.infer<typeof SavedConnectionSchema>;
const variable = 'ASSISTANT_SAVED_CONNECTIONS_V1';
const maximumBytes = 65536;

function validate(input: unknown): SavedConnection[] {
  const saved = SavedConnectionsSchema.parse(input);
  if (
    new Set(saved.map((entry) => entry.profileId)).size !== saved.length ||
    new Set(saved.map((entry) => entry.token)).size !== saved.length
  )
    throw new Error('Duplicate saved connection');
  return saved;
}

/** Backend-only environment file. Encoding is transport escaping, not encryption. */
export function readConnections(path: string): SavedConnection[] {
  try {
    if (!existsSync(path)) return [];
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes)
      throw new Error('Invalid connection file');
    const environment = parseEnv(readFileSync(path, 'utf8'));
    const encoded = environment[variable];
    if (
      Object.keys(environment).length !== 1 ||
      !encoded ||
      !/^[a-zA-Z0-9_-]+$/.test(encoded)
    )
      throw new Error('Invalid connection environment');
    return validate(
      JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown,
    );
  } catch {
    throw new Error(
      'Saved backend connection could not be loaded. Restore or remove .env.connections, then configure again.',
    );
  }
}

function restrictWindowsFile(path: string) {
  if (process.platform !== 'win32') return;
  const system = process.env.SystemRoot ?? 'C:\\Windows';
  const sid = execFileSync(
    join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  ).trim();
  if (!/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('No Windows identity');
  execFileSync(
    join(system, 'System32/icacls.exe'),
    [path, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F'],
    { stdio: 'ignore', windowsHide: true, timeout: 10000 },
  );
}

export function writeConnections(path: string, input: SavedConnection[]) {
  const temporary = `${path}.${randomBytes(12).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    const saved = validate(input);
    // Refuse symlinks, invalid/oversized files and accidental unrelated content.
    if (existsSync(path)) readConnections(path);
    const contents = `# Backend-only credentials. Do not share or commit.\n${variable}=${Buffer.from(JSON.stringify(saved)).toString('base64url')}\n`;
    if (Buffer.byteLength(contents) > maximumBytes)
      throw new Error('Connection file full');
    descriptor = openSync(temporary, 'wx', 0o600);
    // Establish the ACL while the new file is still empty, before writing secrets.
    restrictWindowsFile(temporary);
    writeFileSync(descriptor, contents, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch {
    throw new ServiceFailure('CONFIGURATION_SAVE_FAILED');
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // Never replace the bounded save error with filesystem/credential details.
    }
  }
}
