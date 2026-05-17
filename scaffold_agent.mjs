// scaffold_agent.mjs
import fs from "fs"
import path from "path"

const PLAN_PATH = "./planner_plan.json"
const WORKSPACE = "backend"   // backend workspace folder

function readPlan() {
  if (!fs.existsSync(PLAN_PATH)) {
    throw new Error("planner_plan.json not found.")
  }

  const raw = fs.readFileSync(PLAN_PATH, "utf8")
  return JSON.parse(raw)
}

function ensureWorkspace() {
  if (!fs.existsSync(WORKSPACE)) {
    fs.mkdirSync(WORKSPACE, { recursive: true })
    console.log("📁 Created workspace:", WORKSPACE)
  }
}

function ensureDirectory(filePath) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
}

function createEmptyFile(relativePath) {

  const fullPath = path.join(WORKSPACE, relativePath)

  ensureDirectory(fullPath)

  if (!fs.existsSync(fullPath)) {
    fs.writeFileSync(fullPath, "// TODO: implement\n")
    console.log("✅ Created:", fullPath)
  } else {
    console.log("⚠️ Already exists:", fullPath)
  }
}

function run() {

  console.log("📦 Starting scaffold process...\n")

  ensureWorkspace()

  const plan = readPlan()

  if (!plan.phases || !Array.isArray(plan.phases)) {
    throw new Error("Invalid plan structure: missing phases")
  }

  for (const phase of plan.phases) {

    console.log(`\n🚀 PHASE: ${phase.title}`)

    if (!phase.steps) continue

    for (const step of phase.steps) {

      console.log(`   🔹 STEP: ${step.id}`)

      if (!step.files) continue

      for (const file of step.files) {
        createEmptyFile(file)
      }
    }
  }

  console.log("\n✅ Scaffold complete.")
}

run()
