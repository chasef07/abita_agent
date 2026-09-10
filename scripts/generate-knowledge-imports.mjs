// Offline source-to-import preparation only. Never connects to a database.
// node scripts/generate-knowledge-imports.mjs [--check]
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = "ad3d57550578096ace95df6600143c66d230189d";
const check = process.argv.includes("--check");
const legacyFacts = JSON.parse(
  readFileSync(
    resolve(root, "docs/knowledge/sources/legacy-prompt-facts.json"),
    "utf8",
  ),
);
const offices = {
  "spring-hill": "KNOWLEDGE_SPRINGHILL.md",
  "crystal-river": "KNOWLEDGE_EYERADIANCE.md",
  hollywood: "KNOWLEDGE_HOLLYWOOD.md",
  sweetwater: "KNOWLEDGE_SWEETWATER.md",
  "north-miami-beach-optical": "KNOWLEDGE_NORTH_MIAMI_BEACH_OPTICAL.md",
  "ophthalmology-demo": "KNOWLEDGE_OPHTHALMOLOGY_DEMO.md",
  "new-tampa-demo": "KNOWLEDGE_NEW_TAMPA_DEMO.md",
  "rheumatology-demo": "KNOWLEDGE_RHEUM_DEMO.md",
};
const hash = (text) => createHash("sha256").update(text).digest("hex");
const status = (text) => `Status: available\n\n${text}`;
function replace(text, before, after = "") {
  if (!text.includes(before))
    throw new Error(`Reviewed source changed: ${before.slice(0, 80)}`);
  return text.replace(before, after);
}
function put(path, value) {
  const body = JSON.stringify(value, null, 2) + "\n";
  if (check) {
    if (
      JSON.stringify(JSON.parse(readFileSync(resolve(root, path), "utf8"))) !==
      JSON.stringify(value)
    )
      throw new Error(`Stale generated import: ${path}`);
  } else writeFileSync(resolve(root, path), body);
}
function prepare(key, source) {
  return [
    ...source.matchAll(/^## ([^\n]+)\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm),
  ].flatMap(([, title, original]) => {
    if (title === "Emergency and Urgency") return [];
    let text = original.trim();
    text = text.replaceAll(
      " Say this information is unavailable and keep the answer limited to supplied facts.",
      "",
    );
    if (title === "Limitations") {
      if (key === "new-tampa-demo") text = original.trim();
      else if (key === "ophthalmology-demo")
        text = status(
          "Clearbrook Eye Center, its locations, providers, contact details, and prices are fictional and created only for product demonstrations.",
        );
      else if (key === "rheumatology-demo")
        text = status(
          "Juniper Ridge Rheumatology & Arthritis Care is a fictional practice created for product demonstrations. The medication education in this corpus is general information, not patient-specific medication instructions or treatment recommendations.",
        );
      else return [];
      title = "Source and Demo Limitations";
    }
    if (title === "Location and Contact") {
      text = text.replace(
        / For clinical questions, prescriptions, surgery questions, urgent symptoms, and medical concerns, transfer the call or follow the appropriate scheduling or office workflow\./g,
        "",
      );
      text = text.replace(
        / For non-urgent medication or prescription needs, use the staff-task workflow when available\. Transfer emergency or urgent symptoms, suspected medication reactions, dosage or medication instructions, clinical advice, medical decisions, or callers who still require a live human\./g,
        "",
      );
      if (key === "north-miami-beach-optical")
        text = replace(
          text,
          "If asked whether this is BrightView, simply say: “Yes, you’ve reached the right office!”\n",
          "",
        );
    }
    if (title === "After Hours") {
      if (key === "crystal-river")
        text = status("After-hours doctor: 727-379-4923.");
      if (key === "ophthalmology-demo")
        text = status("The fictional after-hours line is (813) 555-0199.");
      if (key === "new-tampa-demo")
        text = status(
          "This line is a demonstration. The after-hours rehearsal contact is 954-609-7348, not a verified physician line. The demo notification is simulated: no real SMS is sent and no physician is contacted. The public office number is not a verified direct on-call number.",
        );
    }
    if (title === "Hours") {
      if (["hollywood", "sweetwater"].includes(key))
        text += "\n\nClosed Saturday and Sunday."; // pinned prompt.ts supplied this explicit fact
      if (key === "ophthalmology-demo")
        text = replace(
          text,
          "; use current scheduling results for appointment times",
          "",
        );
      if (key === "new-tampa-demo")
        text = replace(
          text,
          " Ask staff to confirm; do not reuse Clearbrook's fictional hours.",
          "",
        );
    }
    if (title === "Scope of Services" || title === "Providers") {
      text = text.replaceAll(
        " Offer cataract appointments only with Dr. Licht.",
        "",
      );
      text = text.replaceAll(
        " Schedule cataract exams with Dr. Bach through medical scheduling.",
        "",
      );
      text = text.replaceAll(
        " If a caller asks for any of these, assume they mean Dr. Licht.",
        "",
      );
      text = text.replaceAll("Name only the providers listed here.", "");
      text = text.replaceAll(
        " If no routine-vision provider is age-eligible, route the patient to Dr. Bach, who is a pediatric ophthalmologist.",
        " Patients below the routine-vision providers' age minimums use pediatric ophthalmology with Dr. Bach.",
      );
      if (key === "crystal-river" && title === "Scope of Services")
        text = replace(
          text,
          " Present only the tests, procedures, and specialty services explicitly listed here; route other availability questions to staff.",
          " Other tests, procedures, and specialty services are not supplied here.",
        );
      if (
        ["hollywood", "sweetwater"].includes(key) &&
        title === "Scope of Services"
      )
        text += `\n\n${key === "hollywood" ? "Hollywood" : "Sweetwater"} does not perform retina surgical care. Retina surgical care requires a retina surgeon; the primary care provider or insurance company can provide a referral when the patient does not have one.`;
      if (key === "new-tampa-demo" && title === "Scope of Services")
        text = replace(
          text,
          " Scheduling triage uses the caller's stated reason, not an agent diagnosis. General or uncertain symptoms need staff guidance rather than a guessed subspecialty.",
          "",
        );
      if (key === "new-tampa-demo" && title === "Providers") {
        const split = text.indexOf(
          "Gretta Fridman and Scott Friedman are different physicians",
        );
        text =
          text.slice(0, split) +
          "Gretta Fridman and Scott Friedman are different physicians with similar-sounding surnames. For this v1 demo, routine exams route to Doctor Bradley Smur. Doctor Scott Friedman specializes in retina care; Doctor Bradley Smur handles glasses prescriptions and routine exams. Availability, provider location, and individual clinical suitability require tool or staff confirmation.";
      }
      if (key === "rheumatology-demo" && title === "Scope of Services") {
        text = replace(
          text,
          "The assistant may explain that combination therapy exists while leaving the caller's actual combination to a clinician or pharmacist with the complete medication list.",
          "The caller's actual combination belongs to a clinician or pharmacist with the complete medication list.",
        );
        text = replace(
          text,
          "so the assistant may explain why a hold question comes up while leaving the caller's stop, hold, and restart instructions to the prescribing clinician.",
          "and the caller's stop, hold, and restart instructions belong to the prescribing clinician.",
        );
        text = replace(
          text,
          "When a caller asks what they personally can take, whether two medicines can be combined, or whether they should change treatment, connect them with clinical staff.",
          "Clinical staff handles what a patient personally can take, which medicines can be combined, and treatment changes.",
        );
      }
    }
    if (
      title === "Optical and Glasses" &&
      [
        "crystal-river",
        "hollywood",
        "sweetwater",
        "north-miami-beach-optical",
        "ophthalmology-demo",
      ].includes(key)
    ) {
      text +=
        "\n\nGlasses pickup policy: a readiness text confirms glasses are ready for pickup; patients wait for that text before coming in. This policy does not establish an individual order's readiness.";
    }
    if (title === "Optical and Glasses" || title === "Contact Lenses") {
      text = text.replaceAll(
        "Ask whether the patient has worn contact lenses in the past.\n\n",
        "",
      );
      text = text.replaceAll(
        "If they need a prescription, schedule them with the optometrist first, then they can browse frames and lenses.",
        "Patients needing a prescription can obtain one through an optometrist appointment.",
      );
      text = text.replaceAll(
        "If they need a prescription, schedule them with the optometrist first.",
        "Patients needing a prescription can obtain one through an optometrist appointment.",
      );
      text = text.replaceAll(
        "If they do not have a valid prescription, schedule a routine eye examination first.",
        "A routine eye examination is available for patients without a valid prescription.",
      );
      if (key === "new-tampa-demo" && title === "Optical and Glasses")
        text = replace(
          text,
          " Use staff for an order status or specific optical policy; do not reuse fictional Clearbrook facts.",
          " Order status and specific optical policies require staff confirmation.",
        );
      if (key === "new-tampa-demo" && title === "Contact Lenses")
        text = replace(
          text,
          "For a routine contact lens appointment request, use the routine vision demo lane.",
          "Routine contact lens appointment requests use the routine vision demo lane.",
        );
    }
    if (title === "Repairs and Warranty" && key === "north-miami-beach-optical")
      text = replace(
        text,
        "If a caller says their glasses are broken or asks whether they are under warranty, tell them to come in so the office can look at the frame or lenses.",
        "Broken glasses and warranty questions require an in-person inspection of the frame or lenses.",
      );
    if (title === "Insurance and Referrals") {
      if (["hollywood", "sweetwater"].includes(key))
        text = status(
          "For routine-vision patients, some insurances do not cover retinal photos and there is a $39 charge.\n\nRetina surgical care needs referral to a retina surgeon. A primary care provider or insurance company can provide an appropriate referral when the patient does not have a retina surgeon.",
        );
      else if (key === "north-miami-beach-optical")
        text = status(
          "For routine-vision patients, some insurances do not cover retinal photos and there is a $39 charge.\n\nMedical insurance checks are not supported for this office. Referral information is not supplied.",
        );
      else {
        text = text.replaceAll(
          "Answer insurance acceptance only from `check_insurance` using the caller's exact plan name. Treat plan acceptance as separate from coverage for a specific visit or procedure.\n\n",
          "Plan acceptance is separate from coverage for a specific visit or procedure.\n\n",
        );
        text = text.replaceAll(
          "Use `check_insurance` before saying whether Clearbrook accepts a medical or routine-vision plan. ",
          "",
        );
        text = text.replaceAll(
          "For every routine-vision patient, explain that some plans do not cover retinal photography and the fictional demo charge is $39.",
          "For routine-vision patients, some plans do not cover retinal photography and the fictional demo charge is $39.",
        );
        text = text.replaceAll(
          " Always use `check_insurance` before saying whether the practice accepts a medical plan.",
          "",
        );
        text = text.replaceAll(
          " Use check_insurance with the exact plan and appropriate coverage type. Label a match as a demo result.",
          " Any insurance participation match is a demo result.",
        );
        text = text.replaceAll(
          " Urgent escalation must not wait for insurance intake.",
          "",
        );
      }
    }
    if (title === "Payments") {
      text = text
        .replaceAll(" Follow the Billing section.", "")
        .replaceAll(
          " Keep full payment-card numbers and security codes outside the conversation.",
          "",
        );
      text = text.replaceAll(
        " For payment handling, follow the Billing section.",
        " Payment handling is owned by the billing department.",
      );
      text = text.replaceAll(
        "; keep full card numbers and security codes out of the conversation",
        "",
      );
    }
    if (title === "Billing") {
      if (["crystal-river", "hollywood", "sweetwater"].includes(key))
        text = status(
          "Billing department number: (786) 446-8333. The billing department handles every billing-related question.",
        );
      if (key === "ophthalmology-demo")
        text = status(
          "The fictional billing department number is (813) 555-0182. Billing-related questions can be handled there or through a staff request when available. A balance, claim, refund, or payment issue remains unconfirmed until supported by system or staff evidence.",
        );
      if (key === "new-tampa-demo")
        text = status(
          "All departments are reached through the public office number, (813) 994-7000. Demo billing questions can be handled through a staff task or demo transfer. Balances, reimbursement, and any separate billing number require staff confirmation.",
        );
    }
    if (title === "Self-Pay Pricing") {
      text = text.replace(
        / If the caller says the cost is too much or they cannot afford it, offer to transfer them to (?:the office|staff) to discuss (?:different|available) options\./g,
        "",
      );
      text = text.replaceAll(
        "Staff must confirm costs; do not quote Clearbrook's fictional prices or retinal photography fee.",
        "Staff must confirm costs.",
      );
    }
    if (title === "Social Follow-Up") {
      if (["hollywood", "sweetwater"].includes(key))
        text = status(
          "Abita Eye Group is on Facebook and Instagram at @abitaeyegroup.",
        );
      text = text.replaceAll(
        " Keep follow-up within approved office channels.",
        "",
      );
    }
    text = text.trim();
    return [
      {
        id: title
          .toLowerCase()
          .replaceAll(/[^a-z0-9]+/g, "-")
          .replace(/-$/, ""),
        title,
        text,
      },
    ];
  });
}
for (const fact of legacyFacts) {
  const pinned = execFileSync(
    "git",
    ["show", `${fact.sourceRevision}:${fact.sourcePath}`],
    { cwd: root, encoding: "utf8" },
  );
  if (hash(pinned) !== fact.sourceSha256 || !pinned.includes(fact.exactFact))
    throw new Error(`Supplemental source changed: ${fact.sourcePath}`);
}
const manifest = { sourceRevision: revision, offices: [], unmappedSources: [] };
for (const [officeKey, file] of Object.entries(offices)) {
  const sourcePath = `docs/knowledge/sources/${file}`;
  const source = readFileSync(resolve(root, sourcePath), "utf8");
  const pinnedSource = execFileSync(
    "git",
    ["show", `${revision}:workspace/${file}`],
    { cwd: root, encoding: "utf8" },
  );
  if (source !== pinnedSource)
    throw new Error(`Archive differs from pinned source: ${file}`);
  const sourceSha256 = hash(source);
  const importPath =
    officeKey === "spring-hill"
      ? "docs/evidence/spring-hill-knowledge-import.json"
      : `docs/knowledge/imports/${officeKey}.json`;
  let corpus;
  if (officeKey === "spring-hill")
    corpus = JSON.parse(readFileSync(resolve(root, importPath), "utf8"));
  else {
    const sections = prepare(officeKey, source);
    if (
      sections.length < 15 ||
      sections.some((section) => section.text.length > 6000)
    )
      throw new Error(`Invalid prepared section count/size: ${officeKey}`);
    const digest = hash(
      `${officeKey}\n${sourceSha256}\n${JSON.stringify(sections)}`,
    );
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    corpus = {
      id,
      practiceId: "00000000-0000-0000-0000-000000000002",
      officeKey,
      expectedRevisionId: "",
      sections,
      // Preserve imported provenance for same-ID replay. Referenced docs remain
      // in Git at 9dd8536b8c01cfdf056901b71da4a1ee0a3db6ec.
      provenance: `Controlled migration of existing repository corpus. Source workspace/${file} at ${revision}; sha256 ${sourceSha256}. Original content archived verbatim at ${sourcePath}; source authors remain attributable through git blame. Facts and qualifications preserved; removed workflow commands are inventoried in docs/knowledge/README.md.${["hollywood", "sweetwater"].includes(officeKey) ? ` Explicit weekend closure also comes from src/prompt.ts at ${revision}.` : ""} ${legacyFacts
        .filter((fact) => fact.applicableOffices.includes(officeKey))
        .map(
          (fact) =>
            ` Additional source ${fact.sourcePath} at ${fact.sourceRevision}; sha256 ${fact.sourceSha256}.`,
        )
        .join("")} No new clinical policy or business approval is implied.`,
      reason: `Migrate existing ${officeKey} knowledge to Product; validate Practice route before applying.`,
    };
    put(importPath, corpus);
  }
  manifest.offices.push({
    officeKey,
    sourcePath,
    sourceSha256,
    additionalSources: legacyFacts.filter((fact) =>
      fact.applicableOffices.includes(officeKey),
    ),
    importPath,
    sectionCount: corpus.sections.length,
    // Match Go encoding/json used by Product, including HTML-safe escapes.
    contentSha256: hash(
      JSON.stringify(corpus.sections).replace(
        /[<>&\u2028\u2029]/g,
        (character) =>
          `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
      ),
    ),
    status:
      officeKey === "spring-hill"
        ? "reuse-current-import"
        : "prepared-needs-route-validation",
  });
}
const unusedSource = "docs/knowledge/sources/KNOWLEDGE_DERM_DEMO.md";
manifest.unmappedSources.push({
  sourcePath: unusedSource,
  sourceSha256: hash(readFileSync(resolve(root, unusedSource), "utf8")),
  status: "archived-no-configured-office-route-no-import",
});
put("docs/knowledge/manifest.json", manifest);
console.log(
  JSON.stringify(
    manifest.offices.map(({ officeKey, sectionCount, status }) => ({
      officeKey,
      sectionCount,
      status,
    })),
  ),
);
