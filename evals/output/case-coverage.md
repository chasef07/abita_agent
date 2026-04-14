# Case Coverage

Golden cases: 32
Candidate cases: 57

## Coverage by suite

| Suite | Golden | Candidates |
| --- | --- | --- |
| cancel | 3 | 3 |
| confirm | 2 | 1 |
| insurance | 2 | 0 |
| language | 1 | 0 |
| quick-question | 2 | 8 |
| registration | 6 | 6 |
| reschedule | 1 | 0 |
| routing | 2 | 0 |
| safety | 1 | 0 |
| scheduling | 3 | 12 |
| transfer | 5 | 27 |
| verification | 4 | 0 |

## Golden composition

| Source | Count |
| --- | --- |
| seed | 31 |
| curated-from-livekit-trace | 1 |

Top policy flags:

| Policy flag | Count |
| --- | --- |
| speak_full_transfer_message_before_call | 4 |
| ask_reason_before_get_availability | 3 |
| cancel_requires_tool_call | 2 |
| do_not_read_back_known_names | 2 |
| ground_practice_facts_in_lookup_knowledge | 2 |
| never_call_add_patient_without_all_fields | 2 |
| transfer_immediately_for_out_of_scope | 2 |
| add_patient_uses_caller_provided_values_exactly | 1 |
| ask_seen_before_when_phone_no_match | 1 |
| book_new_before_cancel_old | 1 |
| cancel_only_the_appointment_caller_specified | 1 |
| check_insurance_for_acceptance_questions | 1 |
| check_insurance_gate_before_collecting_other_fields | 1 |
| collect_insurance_card_fields_before_update_insurance | 1 |
| do_not_cancel_past_appointments | 1 |
| do_not_reroute_routine_adult_at_crystal_river | 1 |
| follow_registration_field_order | 1 |
| match_caller_language | 1 |
| narrow_with_first_name_only | 1 |
| never_give_medical_advice | 1 |

Top style flags:

| Style flag | Count |
| --- | --- |
| concise | 27 |
| empathetic | 2 |
| warm | 2 |
| brief | 1 |
| confident | 1 |
| responds_in_spanish | 1 |

## Candidate composition

| Tag | Count |
| --- | --- |
| needs-review | 54 |
| transfer | 27 |
| scheduling | 12 |
| human-request | 8 |
| knowledge | 8 |
| quick-question | 8 |
| no-fabrication | 6 |
| registration | 6 |
| audit-driven | 4 |
| missing-reason | 4 |
| cancel | 3 |
| bucket:confirm | 2 |
| bucket:immediate_transfer | 2 |
| failure:slow_path | 2 |
| confirm | 1 |
| failure:policy_violation | 1 |
| failure:wrong_tool | 1 |

Most repeated candidate callIds:

| Call ID | Candidate cases |
| --- | --- |
| SCL_NM6DAPgpdzRL | 4 |
| SCL_HBQx8FimhbJd | 3 |
| SCL_JXhzFZbo9euR | 3 |
| SCL_sqzfRD9iU4xJ | 3 |
| SCL_XdF37x2Zmi8w | 3 |
| SCL_6yYgUbhVuBvt | 2 |
| SCL_Cta8p6vxVZh2 | 2 |
| SCL_GSGDsfZwP9nm | 2 |
| SCL_rgb2MvzJJJj7 | 2 |
| SCL_TarxLthDHCzV | 2 |
| SCL_xstNMuRQFqVG | 2 |
| SCL_4esQSyaBvGsD | 1 |
| SCL_6LPmSg3d6Pzo | 1 |
| SCL_8Kva9NnpMiLS | 1 |
| SCL_8YdbfMTHixyk | 1 |

## Coverage gaps

Golden-only suites: insurance, language, reschedule, routing, safety, verification

Candidate-only suites: (none)
