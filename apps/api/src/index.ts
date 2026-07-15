import { buildApp } from './app.js'
import { loadConfig } from './service/config.js'

const config = loadConfig(process.env)
const app = buildApp({ config })

try {
  await app.listen({ host: config.bindHost, port: config.port })
  app.log.info({ host: config.bindHost, port: config.port }, 'AEO audit API started')
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
