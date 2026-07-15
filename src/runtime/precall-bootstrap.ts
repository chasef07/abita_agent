import {
  getOfficeConfigByPhone,
  type OfficeConfig,
} from "../customers/profile.js";
import { lookupByPhone } from "../clients/advancedmd-client.js";
import type { PhoneLookupResult } from "../state/call-state.js";

export interface PreCallBootstrap {
  office: OfficeConfig;
  phoneLookup: PhoneLookupResult;
}

export async function loadPreCallBootstrap({
  callerPhone,
  trunkPhone,
}: {
  callerPhone: string;
  trunkPhone: string;
}): Promise<PreCallBootstrap> {
  const office = getOfficeConfigByPhone(trunkPhone);
  const phoneLookup = await lookupByPhone(callerPhone, trunkPhone);

  return {
    office,
    phoneLookup,
  };
}

export function formatPhoneLookupLogLine(
  _callerPhone: string,
  lookup: PhoneLookupResult,
): string {
  if (lookup?.status === "verified") {
    return `[call] Caller match found`;
  }
  if (lookup?.status === "multiple_matches") {
    return `[call] Multiple caller matches found count=${lookup.matches.length}`;
  }
  if (lookup?.status === "lookup_failed") {
    return `[call] Phone lookup unavailable: ${lookup.reason}`;
  }
  return `[call] No patient match`;
}
