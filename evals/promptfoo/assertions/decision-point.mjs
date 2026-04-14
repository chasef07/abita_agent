import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadCase(casePath) {
  return JSON.parse(readFileSync(resolve(process.cwd(), casePath), "utf-8"));
}

function normalizeOutput(output) {
  if (typeof output === "string") {
    return JSON.parse(output);
  }
  return output;
}

function includesPhrase(text, phrase) {
  return text.toLowerCase().includes(String(phrase).toLowerCase());
}

export default function decisionPointAssertion(output, context) {
  const casePath = context?.vars?.casePath;
  if (!casePath) {
    return {
      pass: false,
      score: 0,
      reason: "Missing casePath in test vars",
    };
  }

  const testCase = loadCase(casePath);
  const result = normalizeOutput(output);
  const finalText = String(result.finalText || "");
  const toolNames = Array.isArray(result.toolCalls)
    ? result.toolCalls.map((toolCall) => toolCall.name)
    : [];
  const expectations = testCase.expectations || {};
  const componentResults = [];

  for (const toolName of expectations.mustCallTools || []) {
    const pass = toolNames.includes(toolName);
    componentResults.push({
      pass,
      score: pass ? 1 : 0,
      reason: pass
        ? `Called required tool ${toolName}`
        : `Did not call required tool ${toolName}`,
      namedScores: { [`must_call:${toolName}`]: pass ? 1 : 0 },
    });
  }

  for (const toolName of expectations.mustNotCallTools || []) {
    const pass = !toolNames.includes(toolName);
    componentResults.push({
      pass,
      score: pass ? 1 : 0,
      reason: pass
        ? `Avoided forbidden tool ${toolName}`
        : `Called forbidden tool ${toolName}`,
      namedScores: { [`must_not_call:${toolName}`]: pass ? 1 : 0 },
    });
  }

  for (const phrase of expectations.mustSay || []) {
    const pass = includesPhrase(finalText, phrase);
    componentResults.push({
      pass,
      score: pass ? 1 : 0,
      reason: pass
        ? `Included required phrase hint "${phrase}"`
        : `Missing required phrase hint "${phrase}"`,
      namedScores: { [`must_say:${phrase}`]: pass ? 1 : 0 },
    });
  }

  for (const phrase of expectations.mustNotSay || []) {
    const pass = !includesPhrase(finalText, phrase);
    componentResults.push({
      pass,
      score: pass ? 1 : 0,
      reason: pass
        ? `Avoided forbidden phrase hint "${phrase}"`
        : `Included forbidden phrase hint "${phrase}"`,
      namedScores: { [`must_not_say:${phrase}`]: pass ? 1 : 0 },
    });
  }

  const total = componentResults.length || 1;
  const passed = componentResults.filter(
    (resultItem) => resultItem.pass,
  ).length;
  const score = passed / total;

  return {
    pass: componentResults.every((resultItem) => resultItem.pass),
    score,
    reason: `${passed}/${total} checks passed`,
    componentResults,
  };
}
