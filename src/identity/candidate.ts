export interface LightweightPatientCandidate {
  status: "candidate";
  patientId: string;
  firstName: string;
  lastName: string;
  dob: string;
}

export interface PatientCandidateSet {
  status: "candidates";
  source: "first_name";
  complete: boolean;
  matches: LightweightPatientCandidate[];
}
