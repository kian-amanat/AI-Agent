import { exec } from "child_process";
import util from "util";

const execAsync = util.promisify(exec);

export async function runTests() {
  try {
    const { stdout, stderr } = await execAsync("npx playwright test");

    return {
      success: true,
      stdout,
      stderr
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
