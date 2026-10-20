/**
 * Print the machine-wide session overview (what `/sessions` shows).
 *
 *   npx tsx scripts/show-sessions.ts
 */
import "../src/polyfills.js"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/service"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig } from "../src/config.js"
import { openDatabase } from "../src/store/db.js"
import { Bridge } from "../src/runtime.js"

const config = loadConfig()
const endpoint = await Service.discover()
if (!endpoint) throw new Error("OpenCode service not running")
const headers = Service.headers(endpoint)
if (!headers) throw new Error("no service credentials")
const client = OpenCode.make({ baseUrl: endpoint.url, headers })

const db = openDatabase(mkdtempSync(join(tmpdir(), "bridge-sessions-")))
const bridge = new Bridge({ config, db, secret: "x", client })

const internals = bridge as unknown as { buildSessionOverview: () => Promise<string> }
console.log(await internals.buildSessionOverview())
process.exit(0)
