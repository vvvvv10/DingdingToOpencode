import { execFile } from "node:child_process"
import { promisify } from "node:util"

const exec = promisify(execFile)

const KEYCHAIN_SERVICE = "opencode-dingtalk-client-secret"

/**
 * Read the DingTalk client secret.
 *
 * Preferred source is the macOS Keychain (the item is created by /usr/bin/security,
 * so reading it through the same binary does not trigger an ACL prompt):
 *
 *   security add-generic-password -U -a "$USER" -s opencode-dingtalk-client-secret -w '<secret>'
 *
 * Environment variable is the fallback for CI / other platforms.
 */
export async function readClientSecret(): Promise<string> {
  const fromEnv = process.env.DINGTALK_CLIENT_SECRET?.trim()
  if (fromEnv) return fromEnv

  try {
    const { stdout } = await exec(
      "/usr/bin/security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", timeout: 5000 },
    )
    const value = stdout.trim()
    if (value) return value
  } catch {
    // fall through to the error below
  }

  throw new Error(
    `DingTalk client secret not found. Add it to the macOS Keychain: ` +
      `security add-generic-password -U -a "$USER" -s ${KEYCHAIN_SERVICE} -w '<secret>' ` +
      `(or set DINGTALK_CLIENT_SECRET)`,
  )
}
