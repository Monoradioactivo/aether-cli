#!/usr/bin/env node

import type * as ParserModule from "./command-parser";
import type * as ExecutorModule from "./command-executor";
import type * as McpServerModule from "./mcp/server";
import type * as ChalkModule from "chalk";

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
  const mcp: typeof McpServerModule = require("./mcp/server");
  const packageJson = require("../../package.json");
  mcp.main({ argv: process.argv.slice(3), version: packageJson.version });
}

if (process.argv[2] === "mcp") {
  runMcpServer();
} else {
  runCommandLine();
}
