import { runCommand } from "./runCommand.js";
import { listFiles } from "./listFiles.js";
import { createFile } from "./createFile.js";
import { editFile } from "./editFile.js";
import { readFile } from "./readFile.js";
import { runTests } from "./runTests.js";

export const tools = {
  run_command: runCommand,
  list_files: listFiles,
  create_file: createFile,
  edit_file: editFile,
  read_file: readFile,
  run_tests: runTests
};
