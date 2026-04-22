# Agent State Machine

This document shows the startup path, router decisions, workflow task groups, and the hidden `CallState` model that drives the agent.

## Whole Agent

```mermaid
flowchart TD
    A[Incoming call] --> B[Pre-call phone lookup]
    B --> C[Create initial CallState in session.userData]
    B --> D[Build startup router prompt]
    C --> E[Start AgentSession]
    D --> E
    E --> F[Play office greeting]

    F --> G[Router turn loop]

    G --> H[FAQ / office info]
    H --> H1[lookup_knowledge]
    H1 --> G

    G --> I[Insurance-only update]
    I --> I1[check_insurance]
    I1 --> I2[update_insurance]
    I2 --> G

    G --> J[Direct new-patient registration]
    J --> J1[run_registration_task]
    J1 --> G

    G --> K[Identify only]
    K --> K1[run_identify_patient_task]
    K1 --> G

    G --> L[Schedule]
    L --> L1[run_schedule_task_group]
    L1 --> G

    G --> M[Reschedule]
    M --> M1[run_reschedule_task_group]
    M1 --> G

    G --> N[Confirm appointment]
    N --> N1[run_confirm_task_group]
    N1 --> G

    G --> O[Cancel appointment]
    O --> O1[run_cancel_task_group]
    O1 --> G

    G --> P[Crystal River route to Spring Hill]
    P --> P1[route_to_spring_hill]
    P1 --> G

    G --> Q[Human handoff]
    Q --> Q1[transfer_call]
```

## Startup Context

```mermaid
flowchart LR
    A[Phone lookup result] --> B[Prompt context]
    A --> C[Hidden state]

    B --> B1["role = SOUL.md"]
    B --> B2["voice = VOICE.md"]
    B --> B3["router = ROUTER.md"]
    B --> B4["context = date/time + caller summary + office routing hints"]

    C --> C1["identity"]
    C --> C2["workflow"]
    C --> C3["scheduling"]
    C --> C4["insurance"]
    C --> C5["conversation"]
```

## Identify Task

```mermaid
stateDiagram-v2
    [*] --> AskWho
    AskWho --> ConfirmCurrentPatient: first name matches preloaded patient
    AskWho --> VerifyExistingPatient: caller gives identity details
    AskWho --> AllowRegistration: caller clearly says new patient

    VerifyExistingPatient --> Identified: verify succeeds
    VerifyExistingPatient --> AskWho: verify miss, retry / clarify
    VerifyExistingPatient --> AllowRegistration: enough failure or clearly new

    ConfirmCurrentPatient --> Identified
    AllowRegistration --> RegistrationAllowed

    Identified --> [*]
    RegistrationAllowed --> [*]
```

## Registration Task

```mermaid
stateDiagram-v2
    [*] --> CheckAllowed
    CheckAllowed --> ExitNotNeeded: registration not allowed / patient already identified
    CheckAllowed --> CollectInsurance: true new patient

    CollectInsurance --> CheckInsurance
    CheckInsurance --> CollectDemographics
    CollectDemographics --> CollectSubscriber
    CollectSubscriber --> ReadBackCriticalFields
    ReadBackCriticalFields --> SubmitRegistration
    SubmitRegistration --> Registered: add_patient succeeds

    ExitNotNeeded --> [*]
    Registered --> [*]
```

## Schedule Flow

```mermaid
stateDiagram-v2
    [*] --> Identify
    Identify --> Register: true new patient
    Identify --> VisitReason: identified existing patient

    Register --> VisitReason: registration complete
    VisitReason --> Availability
    Availability --> SlotSelected
    SlotSelected --> Book
    Book --> Done

    Availability --> VisitReason: caller changes visit reason
    Availability --> Availability: different date search
    SlotSelected --> Availability: caller rejects slot

    Done --> [*]
```

## Reschedule Flow

```mermaid
stateDiagram-v2
    [*] --> Identify
    Identify --> Stop: no existing patient resolved
    Identify --> ExistingAppointment: patient identified

    ExistingAppointment --> VisitReason: reason missing
    ExistingAppointment --> Availability: reason already known

    VisitReason --> Availability
    Availability --> ReplacementSlotSelected
    ReplacementSlotSelected --> BookReplacement
    BookReplacement --> CancelOriginal
    CancelOriginal --> Done

    Availability --> Availability: search another day
    ReplacementSlotSelected --> Availability: caller rejects slot

    Stop --> [*]
    Done --> [*]
```

## Confirm And Cancel Flows

```mermaid
flowchart LR
    A[Confirm flow] --> A1[Identify]
    A1 --> A2[Resolve existing appointment]
    A2 --> A3[Done: read back confirmed appointment]

    B[Cancel flow] --> B1[Identify]
    B1 --> B2[Resolve existing appointment]
    B2 --> B3[Confirm cancellation intent]
    B3 --> B4[cancel_appt]
    B4 --> B5[Done]
```

## Call State Model

```mermaid
flowchart TD
    S[CallState]
    S --> I[identity]
    S --> W[workflow]
    S --> SCH[scheduling]
    S --> INS[insurance]
    S --> C[conversation]

    I --> I1[patientId / patientName / dob]
    I --> I2[lookupMatchStatus]
    I --> I3[callerConfirmedPatient]
    I --> I4[activePatientSource]
    I --> I5[switchedPatientThisCall]

    W --> W1[intent]
    W --> W2[activeFlow]
    W --> W3[appointmentIntent]
    W --> W4[verificationStatus]
    W --> W5[verificationAttempts]
    W --> W6[registrationAllowed]
    W --> W7[registrationComplete]

    SCH --> S1[reasonForVisit]
    SCH --> S2[lastAvailabilityQuery]
    SCH --> S3[lastAvailabilityRaw]
    SCH --> S4[selectedSlot]
    SCH --> S5[targetAppointmentId]
    SCH --> S6[appointments]

    INS --> N1[checkedInsurancePlan]
    INS --> N2[routing]
    INS --> N3[allowedProviders]
    INS --> N4[routingAmbiguous]
    INS --> N5[preauthRequired]

    C --> C1[transferred]
    C --> C2[lastToolCallFingerprint]
```

## Happy Path Summary

### Existing patient schedule

```mermaid
flowchart LR
    A[Caller wants appointment] --> B[Identify patient]
    B --> C[Get reason for visit]
    C --> D[Check availability]
    D --> E[Select slot]
    E --> F[Book appointment]
```

### True new patient schedule

```mermaid
flowchart LR
    A[Caller says they are new] --> B[Run registration]
    B --> C[Check insurance]
    C --> D[Collect demographics and subscriber info]
    D --> E[Create patient]
    E --> F[Get reason for visit]
    F --> G[Check availability]
    G --> H[Select slot]
    H --> I[Book appointment]
```
