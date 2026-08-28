import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline/promises'

import { z } from 'zod'

const OPERATOR_CREDENTIAL_ENV = 'FLAT_OPERATOR_RECOVERY_CREDENTIAL'
const OPERATOR_DEPLOY_ENV = 'FLAT_OPERATOR_RECOVERY_DEPLOY'

const recoveryResponseSchema = z
  .object({
    recovery_code: z.string().startsWith('flat_rec_'),
    expires_at: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  })
  .strict()

const errorResponseSchema = z
  .object({
    error: z.string().regex(/^[a-z0-9_]+$/),
  })
  .strict()

type RecoveryResponse = z.infer<typeof recoveryResponseSchema>

function deployArguments(args: string[]): string[] {
  const result: string[] = []
  let start = 0
  if (args[0] === '--') start = 1
  for (let index = start; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--yes') {
      result.push(argument)
      continue
    }
    if (argument !== '--stage' && argument !== '--profile') {
      throw new Error(`unsupported deployment argument: ${argument}`)
    }
    const value = args[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`${argument} requires a value`)
    }
    result.push(argument, value)
    index += 1
  }
  return result
}

function serverUrl(value: string): string {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('Flat server URL is invalid')
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Flat server URL must use HTTPS')
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Flat server URL must not contain a path, query, or fragment')
  }
  return parsed.origin
}

async function recoveryInputs(): Promise<{ server: string; email: string }> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const rawServer =
      process.env.FLAT_SERVER_URL ?? (await prompt.question('Flat server URL: ')).trim()
    const email =
      process.env.FLAT_OPERATOR_RECOVERY_EMAIL ??
      (await prompt.question('Active admin email: ')).trim()
    if (!email) throw new Error('Active admin email is required')
    return { server: serverUrl(rawServer), email }
  } finally {
    prompt.close()
  }
}

function deploymentEnvironment(credential?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, [OPERATOR_DEPLOY_ENV]: '1' }
  delete environment[OPERATOR_CREDENTIAL_ENV]
  if (credential !== undefined) environment[OPERATOR_CREDENTIAL_ENV] = credential
  return environment
}

async function deploy(args: string[], credential?: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'alchemy', 'deploy', ...args], {
      env: deploymentEnvironment(credential),
      stdio: 'inherit',
    })
    child.on('error', () => reject(new Error('could not start Alchemy deployment')))
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve()
        return
      }
      const outcome = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      reject(new Error(`Alchemy deployment failed with ${outcome}`))
    })
  })
}

async function requestRecovery(
  server: string,
  email: string,
  credential: string
): Promise<RecoveryResponse> {
  const response = await fetch(`${server}/operator/recover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ operator_credential: credential, email }),
  })
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new Error(`operator recovery returned HTTP ${response.status} with invalid JSON`)
  }
  if (!response.ok) {
    const parsedError = errorResponseSchema.safeParse(body)
    const suffix = parsedError.success ? ` (${parsedError.data.error})` : ''
    throw new Error(`operator recovery returned HTTP ${response.status}${suffix}`)
  }
  const parsed = recoveryResponseSchema.safeParse(body)
  if (!parsed.success) throw new Error('operator recovery returned an invalid response')
  return parsed.data
}

function message(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return 'unknown error'
}

async function main(): Promise<void> {
  const args = deployArguments(process.argv.slice(2))
  const { server, email } = await recoveryInputs()
  const credential = `flat_oprec_${randomBytes(32).toString('base64url')}`

  process.stdout.write('Installing the one-time operator verifier...\n')

  let operationError: unknown
  try {
    await deploy(args, credential)
    process.stdout.write('Creating the recovery enrollment...\n')
    const recovery = await requestRecovery(server, email, credential)
    process.stdout.write(`Recovery code: ${recovery.recovery_code}\n`)
    process.stdout.write(`Expires at: ${recovery.expires_at}\n`)
  } catch (error) {
    operationError = error
  }

  process.stdout.write('Removing the one-time operator verifier...\n')
  try {
    await deploy(args)
  } catch (cleanupError) {
    const cleanupMessage = message(cleanupError)
    if (operationError !== undefined) {
      throw new Error(
        `${message(operationError)}; verifier cleanup also failed: ${cleanupMessage}`,
        {
          cause: cleanupError,
        }
      )
    }
    throw new Error(`recovery succeeded, but verifier cleanup failed: ${cleanupMessage}`, {
      cause: cleanupError,
    })
  }

  if (operationError !== undefined) throw operationError
  process.stdout.write('Operator verifier removed.\n')
}

main().catch((cause: unknown) => {
  process.stderr.write(`Operator recovery failed: ${message(cause)}\n`)
  process.exitCode = 1
})
