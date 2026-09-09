# Office information and staff work

The Office Knowledge Hook supplies active-office facts to the answering turn.
It may supply a listed price or department contact alongside a scheduling or
patient-specific request; that reference does not prove an appointment action,
account balance, benefits, or a completed communication.

- Listed self-pay rates: clarify visit type and new/established status; answer
  from the office's supplied rate. Unlisted procedures and final bills still
  require confirmation.
- Address delivery requests: offer the relevant office address aloud, slowly
  enough to write down. A request solely to text the address does not create work.
- Confirmation email: describe the supplied usual practice. Missing confirmation
  or incorrect contact details can require staff follow-up; an agent statement
  is not evidence that a message was sent or delivered.
- Billing: follow the supplied department contact, including optical billing.
- Insurance: plan participation from `check_insurance` does not establish
  individual benefits, copays, or deductibles. Unresolved benefit or insurance
  authorization questions can use staff follow-up in the existing `referrals`
  category with caller agreement.

The Task category contract is unchanged. These agent changes require no portal
code or database migration.

## Verification

`office-knowledge-routing-regression.test.ts` covers the observed English and
Spanish routing failures, owner boundaries, and missing office facts.
`office-knowledge-turn.test.ts` verifies that the actual answering model request
receives the relevant reference without persisting it into later turns.
These deterministic checks do not prove live model wording or email delivery.
