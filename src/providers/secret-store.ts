import crypto from 'node:crypto';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

const APP_SALT = 'agwatch-cookie-store-v1';

// Auth-relevant cookie names — anything else is analytics/tracking noise.
const AUTH_NAME_RE = /session|token|auth|sid|next-auth/i;

export function isAuthCookie(c: { name?: string; httpOnly?: boolean }): boolean {
  return c.httpOnly === true || AUTH_NAME_RE.test(c.name ?? '');
}

function getMachineId(): string {
  try {
    if (process.platform === 'win32') {
      // HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid is a stable per-machine GUID set at OS install.
      const out = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid',
        { encoding: 'utf-8', timeout: 3000, stdio: 'pipe' },
      );
      const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out);
      if (m?.[1]) return m[1];
    } else if (process.platform === 'darwin') {
      // ioreg output: "IOPlatformSerialNumber" = "C02XY1234"
      const out = execSync('ioreg -rd1 -c IOPlatformExpertDevice', {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: 'pipe',
      });
      const m = /IOPlatformSerialNumber[^=]*=\s*"([^"]+)"/.exec(out);
      if (m?.[1]) return m[1];
    } else {
      // systemd (most Linux distros)
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const id = fs.readFileSync(p, 'utf-8').trim();
          if (id.length > 0) return id;
        } catch { /* try next */ }
      }
    }
  } catch { /* fall through to stable fallback */ }
  // Stable per-user fallback — still protects against file extraction / backup exfiltration.
  // os.userInfo() can throw in containers where the UID has no /etc/passwd entry.
  try {
    return `${os.userInfo().username}@${os.hostname()}`;
  } catch {
    return 'agwatch-fallback-key';
  }
}

let _machineId: string | undefined;
function cachedMachineId(): string {
  if (!_machineId) _machineId = getMachineId();
  return _machineId;
}

function deriveKey(providerId: string): Buffer {
  const ikm = Buffer.from(cachedMachineId(), 'utf-8');
  const salt = Buffer.from(APP_SALT, 'utf-8');
  const info = Buffer.from(providerId, 'utf-8');
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));
}

type EncryptedBlob = { v: 1; data: string };

/** Encrypt a cookie array and return the JSON string to write to disk. */
export function encryptCookies(cookies: object[], providerId: string): string {
  const plaintext = JSON.stringify(cookies, null, 2);
  const key = deriveKey(providerId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob: EncryptedBlob = {
    v: 1,
    data: `${iv.toString('base64')}:${tag.toString('base64')}:${body.toString('base64')}`,
  };
  return JSON.stringify(blob);
}

// ─── Windows file ACL helper ──────────────────────────────────────────────────

/**
 * Restrict a file to the current OS user only.
 * On Unix, mode 0o600 at write time is sufficient.
 * On Windows, mode is silently ignored by Node.js, so we call icacls explicitly.
 */
export function setRestrictiveFilePerms(filePath: string): void {
  if (process.platform !== 'win32') return;
  try {
    const user = os.userInfo().username;
    // icacls requires DOMAIN\user on domain-joined machines and COMPUTERNAME\user for
    // local accounts. USERDOMAIN equals COMPUTERNAME for local users and the AD domain
    // name for domain users — correct in both cases.
    const domain = process.env['USERDOMAIN'] ?? process.env['COMPUTERNAME'] ?? '';
    const principal = domain ? `${domain}\\${user}` : user;

    // /inheritance:r  — remove inherited ACEs
    // /grant:r        — replace (not add) an explicit grant for this principal
    // F               — Full control
    const result = spawnSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${principal}:F`], {
      stdio: 'pipe',
      timeout: 3000,
    });

    if (result.status !== 0) {
      // icacls could not set the ACE (e.g. unknown principal, policy restriction).
      // Reset to inherited defaults so the file stays readable — encryption remains
      // the primary protection.
      spawnSync('icacls', [filePath, '/reset'], { stdio: 'pipe', timeout: 3000 });
    }
  } catch { /* non-critical — encryption is the primary protection on Windows */ }
}

/**
 * Decrypt a cookie file's contents back to an array.
 * Transparently handles legacy plain-JSON files (pre-encryption) so existing
 * sessions keep working — they will be re-encrypted on next save.
 */
export function decryptCookies(raw: string, providerId: string): object[] {
  if (raw.trimStart().startsWith('[')) {
    // Legacy plain-JSON format — parse as-is.
    return JSON.parse(raw) as object[];
  }

  const blob = JSON.parse(raw) as EncryptedBlob;
  if (blob.v !== 1 || typeof blob.data !== 'string') {
    throw new Error('Unknown cookie file format');
  }

  const parts = blob.data.split(':');
  if (parts.length !== 3) throw new Error('Malformed encrypted blob');
  const [ivB64, tagB64, dataB64] = parts;

  const key = deriveKey(providerId);
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf-8')) as object[];
}
