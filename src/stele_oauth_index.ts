#!/usr/bin/env node

import { runSteleOAuthCli } from "./stele/oauth-cli.js";

process.exitCode = await runSteleOAuthCli();
