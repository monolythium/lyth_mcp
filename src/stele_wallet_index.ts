#!/usr/bin/env node

import { runSteleWalletCli } from "./stele/wallet-cli.js";

process.exitCode = await runSteleWalletCli();
