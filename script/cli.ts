#!/usr/bin/env node

import type * as ParserModule from "./command-parser";
import type * as ExecutorModule from "./command-executor";
import type * as ChalkModule from "chalk";
import * as path from "path";

function runCommandLine(): void {
  const parser: typeof ParserModule = require("./command-parser");
  const execute: typeof ExecutorModule = require("./command-executor");
  const chalk: typeof ChalkModule = require("chalk");
  const command = parser.createCommand();

  if (parser.parseFailed) {
    process.exit(1);
  }

  if (!command) {
    parser.showHelp(false);
    return;
  }

  execute.execute(command).catch((error: any): void => {
    console.error(chalk.red(`[Error]  ${error.message}`));
    process.exit(1);
  });
}

function runMcpServer(): void {
  const manifestPath = require.resolve("@aetherpush/mcp/package.json");
  const manifest: { bin: Record<string, string> } = require(manifestPath);
  const bin = path.join(path.dirname(manifestPath), manifest.bin["aether-mcp"]);
  process.argv = [process.argv[0], bin, ...process.argv.slice(3)];
  require(bin);
}

if (process.argv[2] === "mcp") {
  runMcpServer();
} else {
  runCommandLine();
}
