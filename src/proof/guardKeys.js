import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateKeyPair, exportPublicJwk, exportPrivateJwk, importPrivateJwk, fingerprint, signText } from '../../shared/crypto.js';

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$p = $env:LEDGERTRUE_GUARD_FILE
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$adminsSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allowed = @($currentSid.Value, $systemSid.Value, $adminsSid.Value)
$acl = Get-Acl -LiteralPath $p
$ownerSid = ([System.Security.Principal.NTAccount]::new($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
if ($ownerSid -notin $allowed) { throw 'Guard key file owner is not an approved principal.' }
if ($env:LEDGERTRUE_SECURE_ACL -eq '1') {
  $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
  & $icacls $p '/inheritance:r' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not remove inherited guard key permissions.' }
  $acl = Get-Acl -LiteralPath $p
  $existingSids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  if ($existingSids.Count) {
    $removeSids = @($existingSids | ForEach-Object { "*$_" })
    & $icacls $p '/remove' @removeSids | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not remove existing guard key permissions.' }
  }
  & $icacls $p '/inheritance:r' '/grant:r' ("*{0}:(F)" -f $currentSid.Value) '*S-1-5-18:(F)' '*S-1-5-32-544:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not apply the restricted guard key ACL.' }
  $acl = Get-Acl -LiteralPath $p
  $ownerSid = ([System.Security.Principal.NTAccount]::new($acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($ownerSid -notin $allowed) { throw 'Guard key file owner is not an approved principal.' }
}
if (-not $acl.AreAccessRulesProtected) { throw 'Guard key ACL inherits permissions.' }
$rules = @($acl.Access)
if ($rules.Count -ne 3) { throw 'Guard key ACL does not contain exactly three approved principals.' }
foreach ($rule in $rules) {
  $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  if ($sid -notin $allowed -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
      [int]$rule.FileSystemRights -ne [int][System.Security.AccessControl.FileSystemRights]::FullControl -or
      $rule.IsInherited -or $rule.InheritanceFlags -ne [System.Security.AccessControl.InheritanceFlags]::None) {
    throw 'Guard key ACL grants unapproved access.'
  }
}
$actualSids = @($rules | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } | Sort-Object)
$expectedSids = @($allowed | Sort-Object)
if (($actualSids -join ',') -cne ($expectedSids -join ',')) {
  throw 'Guard key ACL is missing an approved principal.'
}
Write-Output 'OK'
`;

function runWindowsAcl(file, secure) {
  const command = Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64');
  try {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = execFileSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', command,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        LEDGERTRUE_GUARD_FILE: path.resolve(file),
        LEDGERTRUE_SECURE_ACL: secure ? '1' : '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (output.trim() !== 'OK') throw new Error('Windows ACL verification returned an unexpected response.');
  } catch (error) {
    throw new Error(`Could not ${secure ? 'secure' : 'verify'} Windows guard-key permissions: ${error.message}`);
  }
}

function assertRegularKeyFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Guard key path must be a regular file, not a link.');
}

export function assertGuardKeyPermissions(file) {
  assertRegularKeyFile(file);
  if (process.platform === 'win32') {
    runWindowsAcl(file, false);
  } else {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) !== 0) throw new Error('Guard key file permissions are too open: it must be private (0600).');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('Guard key file must be owned by the current user.');
    }
  }
  return true;
}

function secureGuardKeyFile(file) {
  assertRegularKeyFile(file);
  if (process.platform === 'win32') {
    runWindowsAcl(file, true);
  } else {
    fs.chmodSync(file, 0o600);
    assertGuardKeyPermissions(file);
  }
}

/**
 * The guard is LedgerTrue's own signing identity. Every block hash is signed with it, so editing the
 * stored chain and recomputing hashes is not enough to forge history: the forger would also need this key.
 * The private key is restricted to the current identity (plus system administrators on Windows).
 * Use a KMS/HSM in production.
 */
export async function loadGuard(file = null) {
  if (file && fs.existsSync(file)) {
    secureGuardKeyFile(file);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    const privateKey = await importPrivateJwk(saved.privateJwk);
    return makeGuard(privateKey, saved.publicJwk, saved.privateJwk);
  }
  const pair = await generateKeyPair({ extractable: true });
  const publicJwk = await exportPublicJwk(pair.publicKey);
  const privateJwk = await exportPrivateJwk(pair.privateKey);
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      secureGuardKeyFile(file);
      fs.writeSync(fd, JSON.stringify({ publicJwk, privateJwk }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  return makeGuard(pair.privateKey, publicJwk, privateJwk);
}

async function makeGuard(privateKey, publicJwk) {
  const keyId = await fingerprint(publicJwk);
  return { keyId, publicKeyJwk: publicJwk, sign: (text) => signText(privateKey, text) };
}
