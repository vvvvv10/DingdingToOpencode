/**
 * Unit tests that need no OpenCode service and no DingTalk connection.
 *
 *   npm run test:unit
 */
import { tests } from "../src/unit.test.js"
import { tests as runtimeTests } from "../src/runtime.test.js"

let passed = 0
const failures: Array<{ name: string; error: string }> = []

const all = [...tests, ...runtimeTests]

for (const test of all) {
  try {
    await test.fn()
    passed += 1
    console.log(`  ✓ ${test.name}`)
  } catch (error) {
    failures.push({ name: test.name, error: (error as Error).message })
    console.log(`  ✗ ${test.name}\n      ${(error as Error).message}`)
  }
}

console.log(`\n${passed}/${all.length} 通过`)
if (failures.length > 0) {
  console.log(`失败 ${failures.length} 个:`)
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.error}`)
  process.exit(1)
}
