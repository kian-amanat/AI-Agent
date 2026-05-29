// test_agent.mjs - COMPLETE REWRITE با real-time logging
import { spawn } from "child_process";
import fs from "fs";
import path from "path";

/* -------------------------------------------------- */
/* ---------------- CONFIGURATION ------------------- */
/* -------------------------------------------------- */

const DEFAULT_CONFIG = {
  workspace: "./backend",
  outputDir: "./logs",
  errorReportPath: "./logs/error_report.json",
  tests: [
    { cmd: "npm install", label: "Install dependencies", critical: true },
    { cmd: "npx tsc --noEmit", label: "TypeScript check", critical: false },
    { cmd: "npm run lint", label: "Lint check", critical: false },
    { cmd: "npm test", label: "Run tests", critical: false },
  ],
};

/* -------------------------------------------------- */
/* ------------ ERROR PARSING HELPERS --------------- */
/* -------------------------------------------------- */

function parseTscErrors(output) {
  const errors = [];
  const lines = output.split("\n");
  
  let currentError = null;
  
  for (const line of lines) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(\w+):\s*(.+)$/);
    
    if (match) {
      if (currentError) errors.push(currentError);
      
      currentError = {
        type: "typescript",
        severity: match[4],
        code: match[5],
        message: match[6],
        file: match[1],
        line: parseInt(match[2]),
        column: parseInt(match[3]),
        context: [],
      };
    } else if (currentError && line.trim()) {
      currentError.context.push(line);
    }
  }
  
  if (currentError) errors.push(currentError);
  
  return errors;
}

function parseNpmErrors(output) {
  const errors = [];
  const lines = output.split("\n");
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes("npm ERR!")) {
      const error = {
        type: "npm",
        severity: "error",
        message: line.replace(/npm ERR!\s*/, ""),
        context: [],
      };
      
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        if (lines[j].includes("npm ERR!")) {
          error.context.push(lines[j].replace(/npm ERR!\s*/, ""));
        } else {
          break;
        }
      }
      
      errors.push(error);
    }
    
    if (line.includes("Cannot find module") || line.includes("Module not found")) {
      const moduleMatch = line.match(/['"]([^'"]+)['"]/);
      errors.push({
        type: "module_not_found",
        severity: "error",
        message: line.trim(),
        module: moduleMatch ? moduleMatch[1] : null,
        context: [lines[i + 1], lines[i + 2]].filter(Boolean),
      });
    }
    
    if (line.includes("SyntaxError")) {
      errors.push({
        type: "syntax",
        severity: "error",
        message: line.trim(),
        context: [lines[i - 1], lines[i + 1], lines[i + 2]].filter(Boolean),
      });
    }
  }
  
  return errors;
}

function parseTestErrors(output) {
  const errors = [];
  const lines = output.split("\n");
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    if (line.includes("FAIL") || line.includes("✕")) {
      const error = {
        type: "test_failure",
        severity: "error",
        message: line.trim(),
        context: [],
      };
      
      for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
        if (lines[j].trim() && !lines[j].includes("PASS")) {
          error.context.push(lines[j]);
        } else if (lines[j].includes("PASS") || lines[j].includes("Test Suites:")) {
          break;
        }
      }
      
      errors.push(error);
    }
    
    if (line.includes("Expected:") || line.includes("Received:")) {
      const error = {
        type: "assertion_failure",
        severity: "error",
        message: line.trim(),
        context: [lines[i - 1], lines[i + 1], lines[i + 2]].filter(Boolean),
      };
      errors.push(error);
    }
  }
  
  return errors;
}

function parseErrors(output, command) {
  let errors = [];
  
  if (command.includes("tsc")) {
    errors = parseTscErrors(output);
  } else if (command.includes("npm install") || command.includes("npm ci")) {
    errors = parseNpmErrors(output);
  } else if (command.includes("test")) {
    errors = parseTestErrors(output);
  } else {
    errors = parseNpmErrors(output);
  }
  
  return errors;
}

/* -------------------------------------------------- */
/* -------------- COMMAND EXECUTION ----------------- */
/* -------------------------------------------------- */

/**
 * ✅ NEW: Run command with REAL-TIME output streaming
 */
async function run(cmd, { cwd, label, config } = {}) {
  const title = label ?? cmd;
  console.log(`\n${"=".repeat(60)}`);
  console.log(`🧪 RUN: ${title}`);
  console.log(`> ${cmd}`);
  console.log(`📁 CWD: ${cwd || config.workspace}`);
  console.log(`${"=".repeat(60)}\n`);

  const result = {
    command: cmd,
    label: title,
    ok: false,
    stdout: "",
    stderr: "",
    code: 0,
    errors: [],
    timestamp: new Date().toISOString(),
  };

  return new Promise((resolve) => {
    // ✅ Parse command into parts
    const parts = cmd.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const command = parts[0];
    const args = parts.slice(1).map(arg => arg.replace(/^"|"$/g, ''));
    
    // ✅ Spawn process
    const child = spawn(command, args, {
      cwd: cwd || config.workspace,
      env: process.env,
      shell: true,
    });

    // ✅ Real-time stdout streaming
    child.stdout.on("data", (data) => {
      const text = data.toString();
      result.stdout += text;
      process.stdout.write(text); // ✅ نمایش فوری
    });

    // ✅ Real-time stderr streaming
    child.stderr.on("data", (data) => {
      const text = data.toString();
      result.stderr += text;
      process.stderr.write(text); // ✅ نمایش فوری
    });

    child.on("close", (code) => {
      result.code = code;
      result.ok = code === 0;

      if (result.ok) {
        console.log(`\n✅ OK: ${title}\n`);
      } else {
        // Parse errors
        const combinedOutput = `${result.stdout}\n${result.stderr}`;
        result.errors = parseErrors(combinedOutput, cmd);

        console.error(`\n❌ FAIL: ${title} (exit code: ${code})`);
        console.error(`📊 Parsed ${result.errors.length} error(s)\n`);
      }

      resolve(result);
    });

    child.on("error", (err) => {
      console.error(`\n💥 ERROR: ${title}`, err);
      result.ok = false;
      result.code = 1;
      result.stderr += err.message;
      resolve(result);
    });
  });
}

/* -------------------------------------------------- */
/* -------------- ERROR REPORT GENERATION ----------- */
/* -------------------------------------------------- */

function generateErrorReport(results, config) {
  const failedTests = results.filter((r) => !r.ok);
  
  const report = {
    summary: {
      total: results.length,
      passed: results.filter((r) => r.ok).length,
      failed: failedTests.length,
      timestamp: new Date().toISOString(),
      workspace: config.workspace,
    },
    
    errorsByType: {},
    criticalErrors: [],
    testResults: results,
    filesToFix: new Set(),
    missingModules: new Set(),
    suggestions: [],
  };

  for (const result of failedTests) {
    for (const error of result.errors) {
      if (!report.errorsByType[error.type]) {
        report.errorsByType[error.type] = [];
      }
      report.errorsByType[error.type].push({
        ...error,
        command: result.command,
        label: result.label,
      });

      if (error.file) {
        report.filesToFix.add(error.file);
      }

      if (error.type === "module_not_found" && error.module) {
        report.missingModules.add(error.module);
      }

      if (error.severity === "error") {
        report.criticalErrors.push({
          ...error,
          command: result.command,
          label: result.label,
        });
      }
    }
  }

  report.filesToFix = Array.from(report.filesToFix);
  report.missingModules = Array.from(report.missingModules);

  if (report.missingModules.length > 0) {
    report.suggestions.push({
      type: "install_modules",
      priority: "high",
      action: `npm install ${report.missingModules.join(" ")}`,
      description: `Install ${report.missingModules.length} missing module(s)`,
    });
  }

  if (report.errorsByType.typescript?.length > 0) {
    const fileErrors = {};
    for (const err of report.errorsByType.typescript) {
      if (!fileErrors[err.file]) fileErrors[err.file] = [];
      fileErrors[err.file].push(err);
    }
    
    report.suggestions.push({
      type: "fix_typescript",
      priority: "high",
      files: Object.keys(fileErrors),
      description: `Fix TypeScript errors in ${Object.keys(fileErrors).length} file(s)`,
      details: fileErrors,
    });
  }

  if (report.errorsByType.test_failure?.length > 0) {
    report.suggestions.push({
      type: "fix_tests",
      priority: "medium",
      description: `Fix ${report.errorsByType.test_failure.length} failing test(s)`,
    });
  }

  return report;
}

/* -------------------------------------------------- */
/* ---------------- MAIN FUNCTION ------------------- */
/* -------------------------------------------------- */

export async function runTests(options = {}) {
  const config = { ...DEFAULT_CONFIG, ...options };
  
  console.log("\n" + "=".repeat(60));
  console.log("⚙️  TEST AGENT STARTING");
  console.log("=".repeat(60));
  console.log(`📁 Workspace: ${config.workspace}`);
  console.log(`📊 Tests to run: ${config.tests.length}`);
  console.log(`📄 Error report: ${config.errorReportPath}`);
  console.log("=".repeat(60) + "\n");

  // ✅ Check if workspace exists
  if (!fs.existsSync(config.workspace)) {
    console.error(`❌ Workspace not found: ${config.workspace}`);
    console.log(`\n💡 TIP: Make sure scaffold agent created the workspace first`);
    
    // ✅ Try to read from planner
    if (fs.existsSync("./planner_plan.json")) {
      console.log(`\n📋 Reading planner_plan.json...`);
      const plan = JSON.parse(fs.readFileSync("./planner_plan.json", "utf8"));
      
      // Try different possible workspace keys
      const suggestedWorkspace = 
        plan.workspace || 
        plan.projectRoot || 
        plan.outputDir ||
        plan.structure?.root ||
        "./backend";
      
      console.log(`💡 Planner suggests workspace: ${suggestedWorkspace}`);
      
      if (fs.existsSync(suggestedWorkspace)) {
        console.log(`✅ Using planner workspace: ${suggestedWorkspace}\n`);
        config.workspace = suggestedWorkspace;
      } else {
        console.error(`❌ Planner workspace also not found: ${suggestedWorkspace}`);
        
        // List what we have
        console.log(`\n📂 Current directory contents:`);
        const files = fs.readdirSync(".");
        files.forEach(f => {
          const stat = fs.statSync(f);
          console.log(`  ${stat.isDirectory() ? "📁" : "📄"} ${f}`);
        });
      }
    }
    
    // اگر هنوز workspace نداریم، خطا بده
    if (!fs.existsSync(config.workspace)) {
      const report = {
        summary: {
          total: 0,
          passed: 0,
          failed: 1,
          timestamp: new Date().toISOString(),
          workspace: config.workspace,
        },
        criticalErrors: [{
          type: "workspace_not_found",
          severity: "error",
          message: `Workspace directory not found: ${config.workspace}`,
        }],
        suggestions: [{
          type: "create_workspace",
          priority: "critical",
          description: "Run scaffold agent first to create workspace",
        }],
      };
      
      fs.mkdirSync(config.outputDir, { recursive: true });
      fs.writeFileSync(config.errorReportPath, JSON.stringify(report, null, 2));
      
      console.error(`\n❌ Cannot proceed without workspace. Exiting.\n`);
      
      return {
        success: false,
        report,
        results: [],
      };
    }
  }

  // Ensure output directory exists
  if (!fs.existsSync(config.outputDir)) {
    fs.mkdirSync(config.outputDir, { recursive: true });
  }

  const results = [];
  let shouldStop = false;

  // ✅ Run each test with real-time output
  for (let i = 0; i < config.tests.length; i++) {
    const test = config.tests[i];
    
    if (shouldStop) {
      console.log(`\n⏭️  Skipping: ${test.label} (previous critical failure)\n`);
      continue;
    }

    console.log(`\n📍 Progress: ${i + 1}/${config.tests.length}`);
    
    const result = await run(test.cmd, {
      label: test.label,
      config,
    });
    
    results.push(result);

    if (!result.ok && test.critical) {
      console.error(`\n🛑 Critical test failed: ${test.label}`);
      console.error(`⏸️  Stopping remaining tests\n`);
      shouldStop = true;
    }

    // Progress callback
    if (config.onProgress) {
      config.onProgress({
        type: "test_complete",
        test: test.label,
        success: result.ok,
        totalTests: config.tests.length,
        completedTests: results.length,
      });
    }
  }

  // Generate error report
  const report = generateErrorReport(results, config);
  
  // Save error report
  fs.writeFileSync(
    config.errorReportPath,
    JSON.stringify(report, null, 2),
    "utf8"
  );
  
  console.log(`\n📄 Error report saved: ${config.errorReportPath}`);

  // Save raw logs
  const rawLogsPath = path.join(config.outputDir, "raw_logs.json");
  fs.writeFileSync(
    rawLogsPath,
    JSON.stringify(results, null, 2),
    "utf8"
  );
  
  console.log(`📄 Raw logs saved: ${rawLogsPath}`);

  // Print summary
  console.log("\n" + "=".repeat(60));
  console.log("📊 TEST SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total: ${report.summary.total}`);
  console.log(`✅ Passed: ${report.summary.passed}`);
  console.log(`❌ Failed: ${report.summary.failed}`);
  console.log(`🔥 Critical errors: ${report.criticalErrors.length}`);
  console.log(`📁 Files to fix: ${report.filesToFix.length}`);
  console.log(`📦 Missing modules: ${report.missingModules.length}`);
  console.log("=".repeat(60));

  if (report.suggestions.length > 0) {
    console.log("\n💡 SUGGESTIONS FOR FIXER:");
    for (const suggestion of report.suggestions) {
      console.log(`\n  [${suggestion.priority.toUpperCase()}] ${suggestion.description}`);
      if (suggestion.action) {
        console.log(`  → ${suggestion.action}`);
      }
    }
  }

  console.log("\n");

  return {
    success: report.summary.failed === 0,
    report,
    results,
  };
}

/* -------------------------------------------------- */
/* ------------ STANDALONE EXECUTION ---------------- */
/* -------------------------------------------------- */

if (import.meta.url === `file://${process.argv[1]}`) {
  // ✅ Read workspace from planner if available
  let workspace = "./backend";
  
  if (fs.existsSync("./planner_plan.json")) {
    try {
      const plan = JSON.parse(fs.readFileSync("./planner_plan.json", "utf8"));
      workspace = plan.workspace || plan.projectRoot || plan.outputDir || workspace;
      console.log(`📋 Using workspace from planner: ${workspace}`);
    } catch (e) {
      console.warn(`⚠️  Could not read planner_plan.json:`, e.message);
    }
  }
  
  runTests({
    workspace,
    outputDir: "./logs",
    errorReportPath: "./logs/error_report.json",
  })
    .then(({ success, report }) => {
      if (success) {
        console.log("🎉 All tests passed!");
        process.exit(0);
      } else {
        console.error("❌ Tests failed. Check error report for details.");
        process.exit(1);
      }
    })
    .catch((e) => {
      console.error("💥 Unexpected error:", e);
      process.exit(1);
    });
}
