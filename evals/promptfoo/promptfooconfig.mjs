import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const graderProvider = process.env.PROMPTFOO_GRADER_PROVIDER
  ?? (process.env.OPENAI_API_KEY
    ? 'openai:gpt-4.1-mini'
    : 'anthropic:messages:claude-haiku-4-5-20251001');

export default {
  description: 'LiveKit agent decision-point evals',
  prompts: ['Run decision-point case {{caseId}}'],
  providers: [pathToFileURL(resolve(__dirname, 'livekit-agent-provider.mjs')).href],
  defaultTest: {
    options: {
      provider: graderProvider,
    },
  },
  tests: pathToFileURL(resolve(__dirname, 'tests.mjs')).href,
};
