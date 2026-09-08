import fs from "node:fs";
import path from "node:path";
import {
  getAssemblyAISttOptions,
  getAssemblyAISttProfileOptions,
  type SttProfile,
} from "../src/stt-config.js";
import { voiceTurnHandlingOptions } from "../src/session-options.js";

const [fixturePath] = process.argv.slice(2);
if (!fixturePath)
  throw new Error(
    "Usage: prepare-endpointing-manifest.ts PRIVATE_FIXTURES.json",
  );
const clips = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
// Frozen timing baseline from main 588314c. Vocabulary was unchanged by this PR.
const baselineTiming: Record<SttProfile, [number, number]> = {
  default: [275, 2000],
  insurance: [400, 3000],
  memberId: [450, 3000],
  intake: [450, 3500],
  email: [500, 4000],
};
const cases = clips.flatMap((clip: any) => {
  const profile = clip.profile as SttProfile;
  const [minimum, maximum] = baselineTiming[profile];
  const profileOptions = getAssemblyAISttProfileOptions(profile);
  return [
    {
      clip,
      arm: {
        name: "baseline",
        endpointing: {
          mode: "fixed",
          minDelay: profile === "default" ? 300 : 500,
          maxDelay: profile === "default" ? 600 : 2500,
        },
        stt: {
          provider: "inference",
          options: {
            model: "assemblyai/universal-3-5-pro",
            modelOptions: {
              inactivity_timeout: 30,
              language_detection: true,
              vad_threshold: 0.3,
              min_turn_silence: minimum,
              max_turn_silence: maximum,
              keyterms_prompt: profileOptions.keytermsPrompt,
              agent_context: clip.agentContext,
            },
          },
        },
      },
    },
    {
      clip,
      arm: {
        name: "candidate",
        endpointing: voiceTurnHandlingOptions.endpointing,
        stt: {
          provider: "assemblyai",
          options: {
            ...getAssemblyAISttOptions(),
            ...profileOptions,
            agentContext: clip.agentContext,
          },
        },
      },
    },
  ];
});
const output = path.join(path.dirname(fixturePath), "manifest.json");
fs.writeFileSync(output, JSON.stringify({ cases }, null, 2), { mode: 0o600 });
fs.chmodSync(output, 0o600);
console.log(`Prepared ${cases.length} replay cases.`);
