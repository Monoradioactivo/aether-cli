#!/usr/bin/env node

// Copyright (c) Aether. All rights reserved.

import * as parser from "./command-parser";
import * as execute from "./command-executor";
import * as chalk from "chalk";

function run(): void {
  const command = parser.createCommand();

  if (parser.parseFailed) {
    process.exit(1);
  }

  if (!command) {
    parser.showHelp(/*showRootDescription*/ false);
    return;
  }

  execute.execute(command).catch((error: any): void => {
    console.error(chalk.red(`[Error]  ${error.message}`));
    process.exit(1);
  });
}

run();
