import { initializeLogger } from "@livekit/agents";
import assert from "node:assert/strict";
import { createVoiceAgent } from "../dist/agent.js";
import { getOfficeProfiles } from "../dist/customers/abita/profile.js";
import { buildPrompt } from "../dist/prompt.js";
import { greetingAudio } from "../dist/runtime/greeting-audio.js";
import { loadInsuranceReference } from "../dist/insurance-rules.js";

initializeLogger({ level: "silent", pretty: false });

assert.equal(typeof createVoiceAgent, "function");
for (const office of getOfficeProfiles()) {
  const phone = office.trunkPhones[0];
  assert.ok(buildPrompt(phone).trim(), `${office.key}: missing prompt`);
  const audio = await greetingAudio(phone);
  const reader = audio.getReader();
  try {
    assert.equal(
      (await reader.read()).done,
      false,
      `${office.key}: empty greeting`,
    );
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  for (const visitType of ["medical", "routine_vision"]) {
    const insurance = office.insuranceFor(visitType);
    if (insurance.supported) loadInsuranceReference(insurance.source);
  }
}
console.log(
  "Compiled modules, office prompts, greeting audio, and insurance assets loaded.",
);
