export function classifyErrors(tscOutput) {
  const lines = tscOutput.split("\n");

  const result = {
    importErrors: [],
    typeErrors: [],
    schemaErrors: [],
    missingTypes: [],
    unknown: [],
  };

  for (const line of lines) {
    if (line.includes("TS2307")) {
      result.importErrors.push(line);
      continue;
    }

    if (line.includes("TS2339")) {
      result.schemaErrors.push(line);
      continue;
    }

    if (line.includes("TS7016")) {
      result.missingTypes.push(line);
      continue;
    }

    if (line.includes("TS2769")) {
      result.typeErrors.push(line);
      continue;
    }

    if (line.includes("TS")) {
      result.unknown.push(line);
    }
  }

  return result;
}
