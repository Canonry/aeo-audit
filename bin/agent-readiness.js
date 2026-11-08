#!/usr/bin/env node

import { main } from '../dist/cli.js'

const exitCode = await main(process.argv)
process.exitCode = exitCode
