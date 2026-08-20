/**
 * Dormant content configuration for the fictional behavioral-health demo.
 *
 * Deliberately excludes trunk, middleware-office, and handoff configuration.
 * Add those at the Office Profile boundary only after a dedicated demo number
 * is supplied.
 */
export const MENTAL_HEALTH_DEMO_CONTENT = {
  displayName: "Willowmere Behavioral Health",
  greeting:
    "Hi, you've reached Willowmere Behavioral Health. I'm Maya, the virtual receptionist. What would feel most helpful today?",
  insuranceSource: "INSURANCE_MENTAL_HEALTH_DEMO.json",
  knowledgeSource: "KNOWLEDGE_MENTAL_HEALTH_DEMO.md",
  roleFile: "SOUL_MENTAL_HEALTH_DEMO.md",
} as const;
